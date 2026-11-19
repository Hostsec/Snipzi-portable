// Snipzi desktop backend.
//
// Responsibilities (everything else lives in the web frontend in ../src):
//  - grab the screen(s) natively (xcap)
//  - keep one hidden full-screen overlay window per monitor, ready to show instantly
//  - global hotkeys, tray icon, single instance, start at login
//  - small utilities for the frontend: save file, clipboard, open/reveal, notify,
//    and an HTTP bridge so the ImgBay upload can use the in-app login cookies.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const DEFAULT_REGION_KEY: &str = "Ctrl+Shift+1";
const DEFAULT_SCREEN_KEY: &str = "Ctrl+Shift+2";

struct Frame {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    rgba: Vec<u8>,
}

#[derive(Default)]
struct Capture {
    frames: Vec<Frame>,
    /// A capture (screen grab or overlay session) is in progress; ignore further hotkey presses.
    busy: bool,
    /// Overlays that have not yet reported "frame drawn".
    pending_overlays: usize,
    focus_idx: usize,
    /// Bumped per capture so stale timeouts do not act on a newer capture.
    generation: u64,
}

#[derive(Default)]
struct AppState {
    cap: Mutex<Capture>,
    /// "Mark areas to hide before saving" setting, pushed from the main window.
    redact: AtomicBool,
}

fn overlay_label(i: usize) -> String {
    format!("overlay-{i}")
}

// ---------------------------------------------------------------------------
// Screen grabbing
// ---------------------------------------------------------------------------

fn grab_all() -> Result<Vec<Frame>, String> {
    let mut monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    // Stable order so overlay N always matches frame N.
    monitors.sort_by_key(|m| (m.x().unwrap_or(0), m.y().unwrap_or(0)));

    // One after another: xcap's Monitor handle cannot be shared across threads on Windows.
    let mut frames = Vec::new();
    for m in &monitors {
        let img = m.capture_image().map_err(|e| e.to_string())?;
        let (w, h) = (img.width(), img.height());
        let mut rgba = img.into_raw();
        // Some capture paths leave alpha at 0; a screenshot is always opaque.
        for px in rgba.chunks_exact_mut(4) {
            px[3] = 255;
        }
        frames.push(Frame {
            x: m.x().map_err(|e| e.to_string())?,
            y: m.y().map_err(|e| e.to_string())?,
            w,
            h,
            rgba,
        });
    }
    if frames.is_empty() {
        return Err("No screen found to capture.".into());
    }
    Ok(frames)
}

fn monitor_under_cursor(app: &AppHandle, frames: &[Frame]) -> usize {
    if let Ok(p) = app.cursor_position() {
        let (cx, cy) = (p.x as i32, p.y as i32);
        for (i, f) in frames.iter().enumerate() {
            if cx >= f.x && cx < f.x + f.w as i32 && cy >= f.y && cy < f.y + f.h as i32 {
                return i;
            }
        }
    }
    0
}

// ---------------------------------------------------------------------------
// Overlay windows (one per monitor, created hidden at startup, reused)
// ---------------------------------------------------------------------------

fn ensure_overlays(app: &AppHandle, count: usize) -> Result<(), String> {
    for i in 0..count {
        let label = overlay_label(i);
        if app.get_webview_window(&label).is_some() {
            continue;
        }
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App(format!("overlay.html?i={i}").into()))
            .title("Snipzi capture")
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .focused(false)
            .shadow(false)
            .build()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn hide_overlays(app: &AppHandle) {
    for (label, win) in app.webview_windows() {
        if label.starts_with("overlay-") {
            let _ = win.hide();
        }
    }
}

fn show_overlays(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (geoms, focus_idx): (Vec<(i32, i32, u32, u32)>, usize) = {
        let cap = state.cap.lock().unwrap();
        (cap.frames.iter().map(|f| (f.x, f.y, f.w, f.h)).collect(), cap.focus_idx)
    };
    for (i, (x, y, w, h)) in geoms.iter().enumerate() {
        if let Some(win) = app.get_webview_window(&overlay_label(i)) {
            // Position, show, then position again: avoids Windows rescaling the window
            // when it first appears on a monitor with a different DPI.
            let _ = win.set_position(PhysicalPosition::new(*x, *y));
            let _ = win.set_size(PhysicalSize::new(*w, *h));
            let _ = win.show();
            let _ = win.set_position(PhysicalPosition::new(*x, *y));
            let _ = win.set_size(PhysicalSize::new(*w, *h));
            let _ = win.set_always_on_top(true);
        }
    }
    if let Some(win) = app.get_webview_window(&overlay_label(focus_idx)) {
        let _ = win.set_focus();
    }
}

fn reset_capture(app: &AppHandle, clear_frames: bool) {
    hide_overlays(app);
    let state = app.state::<AppState>();
    let mut cap = state.cap.lock().unwrap();
    cap.busy = false;
    cap.pending_overlays = 0;
    if clear_frames {
        cap.frames.clear();
    }
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Starts a capture. `mode` is "region" or "screen". `delay_ms` lets a window that was just
/// hidden (the Snipzi window itself) disappear before the grab.
fn begin_capture(app: &AppHandle, mode: &str, delay_ms: u64) {
    {
        let state = app.state::<AppState>();
        let mut cap = state.cap.lock().unwrap();
        if cap.busy {
            return;
        }
        cap.busy = true;
        cap.generation += 1;
    }
    let app = app.clone();
    let mode = mode.to_string();
    std::thread::spawn(move || {
        if delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(delay_ms));
        }
        if let Err(e) = run_capture(&app, &mode) {
            reset_capture(&app, true);
            notify(&app, "Snipzi", &format!("Capture failed: {e}"));
        }
    });
}

fn run_capture(app: &AppHandle, mode: &str) -> Result<(), String> {
    let frames = grab_all()?;
    let idx = monitor_under_cursor(app, &frames);
    let count = frames.len();
    let generation;
    {
        let state = app.state::<AppState>();
        let mut cap = state.cap.lock().unwrap();
        cap.frames = frames;
        cap.focus_idx = idx;
        generation = cap.generation;
        if mode == "screen" {
            cap.busy = false;
        } else {
            cap.pending_overlays = count;
        }
    }

    if mode == "screen" {
        app.emit_to("main", "capture:screen", idx).map_err(|e| e.to_string())?;
        return Ok(());
    }

    ensure_overlays(app, count)?;
    let redact = app.state::<AppState>().redact.load(Ordering::Relaxed);
    for i in 0..count {
        app.emit_to(overlay_label(i), "overlay:frame", serde_json::json!({ "idx": i, "redact": redact }))
            .map_err(|e| e.to_string())?;
    }

    // Safety net: if an overlay never reports back, show whatever is ready after 2 s.
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        let still_waiting = {
            let state = app2.state::<AppState>();
            let cap = state.cap.lock().unwrap();
            cap.busy && cap.generation == generation && cap.pending_overlays > 0
        };
        if still_waiting {
            show_overlays(&app2);
        }
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands used by the overlay windows
// ---------------------------------------------------------------------------

/// Raw pixels for one monitor: [width u32 LE][height u32 LE][RGBA bytes].
#[tauri::command]
fn get_frame(state: tauri::State<AppState>, idx: usize) -> Result<Response, String> {
    let cap = state.cap.lock().unwrap();
    let f = cap.frames.get(idx).ok_or("No frame available.")?;
    let mut out = Vec::with_capacity(8 + f.rgba.len());
    out.extend_from_slice(&f.w.to_le_bytes());
    out.extend_from_slice(&f.h.to_le_bytes());
    out.extend_from_slice(&f.rgba);
    Ok(Response::new(out))
}

#[tauri::command]
fn set_redaction(state: tauri::State<AppState>, enabled: bool) {
    state.redact.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn release_frames(state: tauri::State<AppState>) {
    let mut cap = state.cap.lock().unwrap();
    if !cap.busy {
        cap.frames.clear();
    }
}

#[tauri::command]
fn overlay_ready(app: AppHandle) {
    let all_ready = {
        let state = app.state::<AppState>();
        let mut cap = state.cap.lock().unwrap();
        if cap.pending_overlays > 0 {
            cap.pending_overlays -= 1;
            cap.pending_overlays == 0
        } else {
            false
        }
    };
    if all_ready {
        show_overlays(&app);
    }
}

#[derive(Deserialize, Serialize, Clone)]
struct RegionResult {
    idx: usize,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    redactions: Vec<[u32; 4]>,
}

#[tauri::command]
fn finish_region(app: AppHandle, result: RegionResult) {
    hide_overlays(&app);
    {
        let state = app.state::<AppState>();
        state.cap.lock().unwrap().busy = false;
    }
    let _ = app.emit_to("main", "capture:region", result);
}

#[tauri::command]
fn cancel_capture(app: AppHandle) {
    reset_capture(&app, true);
}

// ---------------------------------------------------------------------------
// Commands used by the main window
// ---------------------------------------------------------------------------

#[tauri::command]
fn start_capture(app: AppHandle, mode: String) {
    // Hide the Snipzi window first so it is not part of the screenshot.
    let mut delay = 0;
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            delay = 250;
        }
    }
    begin_capture(&app, &mode, delay);
}

fn header_b64(req: &Request, name: &str) -> Option<String> {
    let v = req.headers().get(name)?.to_str().ok()?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(v).ok()?;
    String::from_utf8(bytes).ok()
}

fn default_save_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .picture_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("Snipzi")
}

#[tauri::command]
fn get_default_save_dir(app: AppHandle) -> String {
    default_save_dir(&app).to_string_lossy().to_string()
}

/// Body = file bytes. Headers: x-dir (base64 utf8, may be empty), x-path (base64 utf8, relative).
#[tauri::command]
fn save_file(app: AppHandle, request: Request) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("No file data received.".into());
    };
    let dir = header_b64(&request, "x-dir").unwrap_or_default();
    let rel = header_b64(&request, "x-path").ok_or("Missing file name.")?;

    let base = if dir.trim().is_empty() { default_save_dir(&app) } else { PathBuf::from(dir.trim()) };
    let mut target = base;
    let parts: Vec<&str> = rel.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return Err("Empty file name.".into());
    }
    for p in &parts {
        if *p == ".." || *p == "." || p.contains(':') {
            return Err("Invalid file path in the folder or file name pattern.".into());
        }
        target.push(p);
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create the folder: {e}"))?;
    }
    // Never overwrite: "name.png" -> "name (2).png".
    if target.exists() {
        let stem = target.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = target.extension().map(|s| s.to_string_lossy().to_string());
        let parent = target.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let mut n = 2;
        loop {
            let name = match &ext {
                Some(e) => format!("{stem} ({n}).{e}"),
                None => format!("{stem} ({n})"),
            };
            let candidate = parent.join(name);
            if !candidate.exists() {
                target = candidate;
                break;
            }
            n += 1;
        }
    }
    std::fs::write(&target, bytes).map_err(|e| format!("Could not save the file: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

/// Body = raw RGBA. Headers: x-w, x-h.
#[tauri::command]
fn copy_image(request: Request) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("No image data received.".into());
    };
    let num = |name: &str| -> Result<usize, String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<usize>().ok())
            .ok_or_else(|| "Missing image size.".to_string())
    };
    let (w, h) = (num("x-w")?, num("x-h")?);
    if bytes.len() != w * h * 4 {
        return Err("Image data has the wrong size.".into());
    }
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_image(arboard::ImageData { width: w, height: h, bytes: std::borrow::Cow::Borrowed(bytes) })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())
}

/// Sends a file to the Recycle Bin (recoverable) rather than erasing it.
#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Not a web address.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn notify_user(app: AppHandle, title: String, body: String) {
    notify(&app, &title, &body);
}

#[tauri::command]
fn set_hotkeys(app: AppHandle, region: String, screen: String) -> Result<(), String> {
    register_hotkeys(&app, &region, &screen)
}

fn register_hotkeys(app: &AppHandle, region: &str, screen: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    if !region.trim().is_empty() {
        gs.on_shortcut(region, |app, _s, ev| {
            if ev.state == ShortcutState::Pressed {
                begin_capture(app, "region", 0);
            }
        })
        .map_err(|e| format!("Could not use \"{region}\" for region capture: {e}"))?;
    }
    if !screen.trim().is_empty() {
        gs.on_shortcut(screen, |app, _s, ev| {
            if ev.state == ShortcutState::Pressed {
                begin_capture(app, "screen", 0);
            }
        })
        .map_err(|e| format!("Could not use \"{screen}\" for screen capture: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let al = app.autolaunch();
    if enabled { al.enable() } else { al.disable() }.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// ImgBay bridge: HTTP from Rust (no browser CORS), with the login cookies that
// the in-app "Log in to ImgBay" window stored in the shared web profile.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct FileArg {
    name: String,
    filename: String,
    mime: String,
    b64: String,
}

#[derive(Deserialize)]
struct HttpArgs {
    url: String,
    method: String,
    fields: Vec<(String, String)>,
    file: Option<FileArg>,
}

#[derive(Serialize)]
struct HttpResp {
    status: u16,
    body: String,
}

#[tauri::command]
async fn http_request(app: AppHandle, args: HttpArgs) -> Result<HttpResp, String> {
    let url = tauri::Url::parse(&args.url).map_err(|e| e.to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("Only http(s) addresses are allowed.".into());
    }
    let cookie_header = match app.get_webview_window("main") {
        Some(win) => win
            .cookies_for_url(url.clone())
            .map(|cs| cs.iter().map(|c| format!("{}={}", c.name(), c.value())).collect::<Vec<_>>().join("; "))
            .unwrap_or_default(),
        None => String::new(),
    };

    let client = reqwest::Client::builder()
        .user_agent("Snipzi-Desktop")
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;
    let method = reqwest::Method::from_bytes(args.method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(method, url);
    if !cookie_header.is_empty() {
        req = req.header(reqwest::header::COOKIE, cookie_header);
    }
    if args.file.is_some() || !args.fields.is_empty() {
        let mut form = reqwest::multipart::Form::new();
        for (k, v) in args.fields {
            form = form.text(k, v);
        }
        if let Some(f) = args.file {
            let bytes = base64::engine::general_purpose::STANDARD.decode(f.b64).map_err(|e| e.to_string())?;
            let part = reqwest::multipart::Part::bytes(bytes)
                .file_name(f.filename)
                .mime_str(&f.mime)
                .map_err(|e| e.to_string())?;
            form = form.part(f.name, part);
        }
        req = req.multipart(form);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(HttpResp { status, body })
}

#[tauri::command]
async fn imgbay_login(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Enter a valid ImgBay address first.".to_string())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("The ImgBay address must start with https:// or http://".into());
    }
    if let Some(w) = app.get_webview_window("imgbay-login") {
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "imgbay-login", WebviewUrl::External(parsed))
        .title("Log in to ImgBay (tick Remember me, then close this window)")
        .inner_size(900.0, 720.0)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_frame,
            release_frames,
            set_redaction,
            overlay_ready,
            finish_region,
            cancel_capture,
            start_capture,
            get_default_save_dir,
            save_file,
            copy_image,
            copy_text,
            open_path,
            delete_file,
            reveal_path,
            open_url,
            notify_user,
            set_hotkeys,
            get_autostart,
            set_autostart,
            http_request,
            imgbay_login,
        ])
        .on_window_event(|window, event| {
            // Closing the main window only hides it; the app lives in the tray.
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // Tray icon and menu.
            let m_region = MenuItem::with_id(app, "region", "Capture region", true, None::<&str>)?;
            let m_screen = MenuItem::with_id(app, "screen", "Capture screen", true, None::<&str>)?;
            let m_open = MenuItem::with_id(app, "open", "Open Snipzi", true, None::<&str>)?;
            let m_quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&m_region, &m_screen, &m_open, &m_quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("Snipzi")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "region" => begin_capture(app, "region", 150),
                    "screen" => begin_capture(app, "screen", 150),
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Default hotkeys right away; the frontend re-registers the user's own on load.
            if let Err(e) = register_hotkeys(&handle, DEFAULT_REGION_KEY, DEFAULT_SCREEN_KEY) {
                eprintln!("hotkeys: {e}");
            }

            // Pre-create one hidden overlay per monitor so a region capture opens instantly.
            if let Ok(mons) = xcap::Monitor::all() {
                let _ = ensure_overlays(&handle, mons.len().max(1));
            }

            // Show the window unless started by "start at login".
            if !std::env::args().any(|a| a == "--hidden") {
                show_main(&handle);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Snipzi");
}
