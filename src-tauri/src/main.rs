// Snipzi desktop backend.
//
// Responsibilities (everything else lives in the web frontend in ../src):
//  - grab the screen(s) natively (xcap)
//  - keep one hidden full-screen overlay window per monitor, ready to show instantly
//  - global hotkeys, tray icon, single instance, start at login
//  - small utilities for the frontend: save file, clipboard, open/reveal, notify,
//    and an HTTP bridge so the ImgBay upload can use the in-app login cookies.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

mod stitch;

/// Mouse wheel and cursor control, used by scrolling capture. Windows only.
#[cfg(windows)]
mod winput {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_WHEEL, MOUSEINPUT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};

    pub fn cursor() -> (i32, i32) {
        let mut p = POINT { x: 0, y: 0 };
        unsafe {
            GetCursorPos(&mut p);
        }
        (p.x, p.y)
    }
    pub fn move_cursor(x: i32, y: i32) {
        unsafe {
            SetCursorPos(x, y);
        }
    }
    /// One wheel event. Negative = scroll down.
    pub fn wheel(delta: i32) -> bool {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: delta as u32, dwFlags: MOUSEEVENTF_WHEEL, time: 0, dwExtraInfo: 0 },
            },
        };
        unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) == 1 }
    }
}

#[cfg(not(windows))]
mod winput {
    pub fn cursor() -> (i32, i32) {
        (0, 0)
    }
    pub fn move_cursor(_x: i32, _y: i32) {}
    pub fn wheel(_delta: i32) -> bool {
        false
    }
}

const DEFAULT_REGION_KEY: &str = "Ctrl+Shift+1";
const DEFAULT_SCREEN_KEY: &str = "Ctrl+Shift+2";
const DEFAULT_WINDOW_KEY: &str = "Ctrl+Shift+3";
const DEFAULT_UPLOAD_KEY: &str = "Ctrl+Shift+4";
const DEFAULT_SCROLL_KEY: &str = "Ctrl+Shift+5";
const DEFAULT_PICKER_KEY: &str = "Ctrl+Shift+6";
const DEFAULT_RULER_KEY: &str = "Ctrl+Shift+7";
/// Longest scrolling capture, in pixels (width x height). About 20,000 px tall at full HD width.
const SCROLL_MAX_PIXELS: usize = 40_000_000;

struct Frame {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    rgba: Vec<u8>,
}

#[derive(Clone)]
struct WinRect {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    title: String,
}

#[derive(Default)]
struct Capture {
    frames: Vec<Frame>,
    windows: Vec<WinRect>,
    /// A capture (countdown, screen grab or overlay session) is in progress; ignore hotkeys.
    busy: bool,
    /// Overlays that have not yet reported "frame drawn".
    pending_overlays: usize,
    focus_idx: usize,
    /// Bumped per capture so stale timeouts do not act on a newer capture.
    generation: u64,
    /// "region", "window", "screen", "scroll", "picker" or "ruler".
    mode: String,
    /// Upload to ImgBay once saved (the "capture and upload" shortcut).
    upload: bool,
    countdown: u32,
    /// Height of the scrolling capture gathered so far.
    scroll_px: usize,
}

#[derive(Clone, Copy)]
struct Options {
    edit_before_save: bool,
    delay_secs: u32,
    keep_overlays: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { edit_before_save: false, delay_secs: 0, keep_overlays: true }
    }
}

#[derive(Default)]
struct AppState {
    cap: Mutex<Capture>,
    opts: Mutex<Options>,
    /// Overlay windows whose page has loaded and is listening for frames.
    loaded: Mutex<HashSet<usize>>,
    popup: Mutex<Option<Value>>,
    /// Set by the Esc key while a scrolling capture runs.
    stop_scroll: AtomicBool,
}

fn overlay_label(i: usize) -> String {
    format!("overlay-{i}")
}

// ---------------------------------------------------------------------------
// Screen and window grabbing
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

/// Visible top-level windows, topmost first.
fn list_windows() -> Vec<WinRect> {
    let mut found: Vec<(i32, WinRect)> = Vec::new();
    if let Ok(all) = xcap::Window::all() {
        for w in all {
            let (Ok(x), Ok(y), Ok(ww), Ok(hh)) = (w.x(), w.y(), w.width(), w.height()) else {
                continue;
            };
            if w.is_minimized().unwrap_or(false) || ww < 40 || hh < 40 {
                continue;
            }
            let mut title = w.title().unwrap_or_default();
            if title.trim().is_empty() {
                title = w.app_name().unwrap_or_default();
            }
            found.push((w.z().unwrap_or(0), WinRect { x, y, w: ww, h: hh, title }));
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, r)| r).collect()
}

/// The windows that touch one monitor, in that monitor's own pixel coordinates.
fn windows_for(frame: &Frame, wins: &[WinRect]) -> Vec<Value> {
    let mut out = Vec::new();
    for w in wins {
        let x0 = (w.x - frame.x).max(0);
        let y0 = (w.y - frame.y).max(0);
        let x1 = (w.x + w.w as i32 - frame.x).min(frame.w as i32);
        let y1 = (w.y + w.h as i32 - frame.y).min(frame.h as i32);
        if x1 - x0 < 20 || y1 - y0 < 20 {
            continue;
        }
        out.push(json!({ "x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0, "title": w.title }));
    }
    out
}

fn cursor_monitor(app: &AppHandle) -> Option<tauri::Monitor> {
    let p = app.cursor_position().ok()?;
    let monitors = app.available_monitors().ok()?;
    for m in &monitors {
        let pos = m.position();
        let size = m.size();
        if p.x >= pos.x as f64
            && p.x < (pos.x + size.width as i32) as f64
            && p.y >= pos.y as f64
            && p.y < (pos.y + size.height as i32) as f64
        {
            return Some(m.clone());
        }
    }
    monitors.into_iter().next()
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
// Overlay windows (one per monitor). Kept hidden and ready, or created on demand
// when "fast capture" is off.
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

fn destroy_overlays(app: &AppHandle) {
    for (label, win) in app.webview_windows() {
        if label.starts_with("overlay-") {
            let _ = win.destroy();
        }
    }
    app.state::<AppState>().loaded.lock().unwrap().clear();
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

/// Ends an overlay session: hide (or destroy, in memory-saving mode) the overlays and
/// allow the next capture.
fn finish_session(app: &AppHandle, clear_frames: bool) {
    hide_overlays(app);
    let keep = app.state::<AppState>().opts.lock().unwrap().keep_overlays;
    let app2 = app.clone();
    let work = move || {
        if !keep {
            destroy_overlays(&app2);
        }
        let state = app2.state::<AppState>();
        let mut cap = state.cap.lock().unwrap();
        cap.busy = false;
        cap.pending_overlays = 0;
        if clear_frames {
            cap.frames.clear();
        }
    };
    if keep {
        work();
    } else {
        std::thread::spawn(work);
    }
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

// ---------------------------------------------------------------------------
// Small helper windows: countdown and post-capture pop-up
// ---------------------------------------------------------------------------

fn place_on_cursor_monitor(app: &AppHandle, win: &WebviewWindow, w: f64, h: f64, corner: bool) {
    if let Some(m) = cursor_monitor(app) {
        let s = m.scale_factor();
        let wa = m.work_area();
        let (pw, ph) = ((w * s) as u32, (h * s) as u32);
        let margin = (16.0 * s) as i32;
        let (x, y) = if corner {
            (
                wa.position.x + wa.size.width as i32 - pw as i32 - margin,
                wa.position.y + wa.size.height as i32 - ph as i32 - margin,
            )
        } else {
            (
                wa.position.x + (wa.size.width as i32 - pw as i32) / 2,
                wa.position.y + (wa.size.height as i32 - ph as i32) / 2,
            )
        };
        let _ = win.set_size(PhysicalSize::new(pw, ph));
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
}

fn helper_window(app: &AppHandle, label: &str, url: &str, w: f64, h: f64) -> Result<WebviewWindow, String> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("Snipzi")
        .inner_size(w, h)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .focusable(false)
        .build()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Capture flow
// ---------------------------------------------------------------------------

/// Starts a capture. `mode` is "region", "window" or "screen". `extra_delay_ms` lets a window
/// that was just hidden disappear first; the user's own delay timer is added on top.
fn begin_capture(app: &AppHandle, mode: &str, extra_delay_ms: u64, upload: bool) {
    {
        let state = app.state::<AppState>();
        let mut cap = state.cap.lock().unwrap();
        if cap.busy {
            return;
        }
        cap.busy = true;
        cap.generation += 1;
        cap.mode = mode.to_string();
        cap.upload = upload;
    }
    let app = app.clone();
    let mode = mode.to_string();
    std::thread::spawn(move || {
        if extra_delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(extra_delay_ms));
        }
        let secs = app.state::<AppState>().opts.lock().unwrap().delay_secs;
        if secs > 0 {
            run_countdown(&app, secs);
        }
        if let Err(e) = run_capture(&app, &mode) {
            finish_session(&app, true);
            notify(&app, "Snipzi", &format!("Capture failed: {e}"));
        }
    });
}

fn run_countdown(app: &AppHandle, secs: u32) {
    let win = helper_window(app, "countdown", "countdown.html", 150.0, 150.0).ok();
    if let Some(w) = &win {
        place_on_cursor_monitor(app, w, 150.0, 150.0, false);
        let _ = w.show();
    }
    for n in (1..=secs).rev() {
        app.state::<AppState>().cap.lock().unwrap().countdown = n;
        std::thread::sleep(Duration::from_secs(1));
    }
    app.state::<AppState>().cap.lock().unwrap().countdown = 0;
    if let Some(w) = win {
        let _ = w.destroy();
    }
    // Let the countdown window disappear from the screen before grabbing it.
    std::thread::sleep(Duration::from_millis(250));
}

fn run_capture(app: &AppHandle, mode: &str) -> Result<(), String> {
    let frames = grab_all()?;
    let windows = if mode == "window" { list_windows() } else { Vec::new() };
    let idx = monitor_under_cursor(app, &frames);
    let count = frames.len();
    let generation;
    {
        let state = app.state::<AppState>();
        let mut cap = state.cap.lock().unwrap();
        cap.frames = frames;
        cap.windows = windows;
        cap.focus_idx = idx;
        generation = cap.generation;
        if mode == "screen" {
            cap.busy = false;
        } else {
            cap.pending_overlays = count;
        }
    }

    if mode == "screen" {
        app.emit_to("main", "capture:screen", json!({ "idx": idx })).map_err(|e| e.to_string())?;
        return Ok(());
    }

    ensure_overlays(app, count)?;
    // Overlays created on demand (memory-saving mode) need a moment to load their page.
    for _ in 0..300 {
        let ready = {
            let state = app.state::<AppState>();
            let loaded = state.loaded.lock().unwrap();
            (0..count).all(|i| loaded.contains(&i))
        };
        if ready {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    let (edit, upload) = {
        let state = app.state::<AppState>();
        let edit = state.opts.lock().unwrap().edit_before_save;
        let upload = state.cap.lock().unwrap().upload;
        (edit, upload)
    };
    for i in 0..count {
        let wins = {
            let state = app.state::<AppState>();
            let cap = state.cap.lock().unwrap();
            if mode == "window" { windows_for(&cap.frames[i], &cap.windows) } else { Vec::new() }
        };
        app.emit_to(
            overlay_label(i),
            "overlay:frame",
            json!({ "idx": i, "mode": mode, "edit": edit, "upload": upload, "windows": wins }),
        )
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
fn release_frames(state: tauri::State<AppState>) {
    let mut cap = state.cap.lock().unwrap();
    if !cap.busy {
        cap.frames.clear();
    }
}

#[tauri::command]
fn overlay_loaded(state: tauri::State<AppState>, idx: usize) {
    state.loaded.lock().unwrap().insert(idx);
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
    /// Annotations drawn in the editor (arrows, text, hide boxes ...), in monitor pixels.
    shapes: Vec<Value>,
    /// The user clicked "Save and upload" in the editor.
    upload: bool,
}

#[tauri::command]
fn finish_region(app: AppHandle, result: RegionResult) {
    let (kind, upload) = {
        let state = app.state::<AppState>();
        let cap = state.cap.lock().unwrap();
        (cap.mode.clone(), cap.upload || result.upload)
    };
    if kind == "scroll" {
        start_scroll(&app, result, upload);
        return;
    }
    let payload = json!({
        "idx": result.idx, "x": result.x, "y": result.y, "w": result.w, "h": result.h,
        "shapes": result.shapes, "kind": kind, "upload": upload,
    });
    let _ = app.emit_to("main", "capture:region", payload);
    finish_session(&app, false);
}

#[tauri::command]
fn cancel_capture(app: AppHandle) {
    finish_session(&app, true);
}

#[derive(Deserialize)]
struct PickResult {
    r: u8,
    g: u8,
    b: u8,
    x: u32,
    y: u32,
}

/// The colour picker finished: hand the colour to the main window.
#[tauri::command]
fn finish_pick(app: AppHandle, result: PickResult) {
    let _ = app.emit_to("main", "capture:color", json!({ "r": result.r, "g": result.g, "b": result.b, "x": result.x, "y": result.y }));
    finish_session(&app, true);
}

// ---------------------------------------------------------------------------
// Scrolling capture: scroll the chosen area with the mouse wheel, grab it after every
// step and stitch the views together (see stitch.rs for how).
// ---------------------------------------------------------------------------

struct WinIo {
    monitor: xcap::Monitor,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    cx: i32,
    cy: i32,
    app: AppHandle,
}

impl WinIo {
    fn capture(&self) -> Result<stitch::Img, String> {
        let img = self.monitor.capture_region(self.x, self.y, self.w, self.h).map_err(|e| e.to_string())?;
        let (w, h) = (img.width() as usize, img.height() as usize);
        let mut rgba = img.into_raw();
        for px in rgba.chunks_exact_mut(4) {
            px[3] = 255;
        }
        Ok(stitch::Img::new(w, h, rgba))
    }
}

impl stitch::ScrollIo for WinIo {
    /// A view that has stopped moving (smooth scrolling takes a moment to settle).
    fn grab(&mut self) -> Result<stitch::Img, String> {
        std::thread::sleep(Duration::from_millis(140));
        let mut last = self.capture()?;
        for _ in 0..16 {
            std::thread::sleep(Duration::from_millis(70));
            let cur = self.capture()?;
            if cur.rgba == last.rgba {
                return Ok(cur);
            }
            last = cur;
        }
        Ok(last)
    }
    fn wheel(&mut self, notches: i32) {
        // keep the pointer over the area even if the user nudged the mouse
        winput::move_cursor(self.cx, self.cy);
        winput::wheel(-notches * 120);
    }
    fn stopped(&self) -> bool {
        self.app.state::<AppState>().stop_scroll.load(Ordering::SeqCst)
    }
    fn progress(&mut self, height: usize) {
        self.app.state::<AppState>().cap.lock().unwrap().scroll_px = height;
    }
}

#[tauri::command]
fn get_scroll_status(state: tauri::State<AppState>) -> usize {
    state.cap.lock().unwrap().scroll_px
}

/// A small "Scrolling..." card, placed where it does not cover the captured area.
fn show_scroll_status(app: &AppHandle, region: (i32, i32, u32, u32)) -> Option<WebviewWindow> {
    let m = cursor_monitor(app)?;
    let s = m.scale_factor();
    let (pw, ph) = ((300.0 * s) as i32, (64.0 * s) as i32);
    let (mp, ms) = (m.position(), m.size());
    let (mx0, my0, mx1, my1) = (mp.x, mp.y, mp.x + ms.width as i32, mp.y + ms.height as i32);
    let (rx, ry, rw, rh) = (region.0, region.1, region.2 as i32, region.3 as i32);
    let gap = 10;
    let cx = (rx + rw / 2 - pw / 2).clamp(mx0, (mx1 - pw).max(mx0));
    let cy = (ry + rh / 2 - ph / 2).clamp(my0, (my1 - ph).max(my0));
    let spots = [(cx, ry + rh + gap), (cx, ry - ph - gap), (rx + rw + gap, cy), (rx - pw - gap, cy)];
    let (x, y) = spots.into_iter().find(|(x, y)| *x >= mx0 && *y >= my0 && *x + pw <= mx1 && *y + ph <= my1)?;
    let win = helper_window(app, "scrollstat", "scrollstat.html", 300.0, 64.0).ok()?;
    let _ = win.set_size(PhysicalSize::new(pw as u32, ph as u32));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.show();
    Some(win)
}

fn start_scroll(app: &AppHandle, r: RegionResult, upload: bool) {
    hide_overlays(app);
    let app = app.clone();
    std::thread::spawn(move || match do_scroll(&app, &r) {
        Ok((frame, note)) => {
            let (w, h) = (frame.w, frame.h);
            app.state::<AppState>().cap.lock().unwrap().frames = vec![frame];
            let _ = app.emit_to(
                "main",
                "capture:region",
                json!({ "idx": 0, "x": 0, "y": 0, "w": w, "h": h, "shapes": [], "kind": "scroll", "upload": upload, "note": note }),
            );
            finish_session(&app, false);
        }
        Err(e) => {
            finish_session(&app, true);
            notify(&app, "Snipzi", &e);
            let _ = app.emit_to("main", "capture:failed", e);
        }
    });
}

fn do_scroll(app: &AppHandle, r: &RegionResult) -> Result<(Frame, Option<String>), String> {
    if !cfg!(windows) {
        return Err("Scrolling capture is only available on Windows.".into());
    }
    // Let the capture overlay disappear before the first grab.
    std::thread::sleep(Duration::from_millis(280));

    let mut monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    monitors.sort_by_key(|m| (m.x().unwrap_or(0), m.y().unwrap_or(0)));
    if r.idx >= monitors.len() {
        return Err("The screen changed while capturing. Please try again.".into());
    }
    let monitor = monitors.swap_remove(r.idx);
    let (mx, my) = (monitor.x().map_err(|e| e.to_string())?, monitor.y().map_err(|e| e.to_string())?);
    let (mw, mh) = (monitor.width().map_err(|e| e.to_string())?, monitor.height().map_err(|e| e.to_string())?);
    let x = r.x.min(mw.saturating_sub(1));
    let y = r.y.min(mh.saturating_sub(1));
    let w = r.w.min(mw - x);
    let h = r.h.min(mh - y);
    if w < 40 || h < 100 {
        return Err("That area is too small for a scrolling capture. Select a taller area.".into());
    }
    let (cx, cy) = (mx + x as i32 + w as i32 / 2, my + y as i32 + h as i32 / 2);

    let state = app.state::<AppState>();
    state.stop_scroll.store(false, Ordering::SeqCst);
    state.cap.lock().unwrap().scroll_px = h as usize;

    let before = winput::cursor();
    winput::move_cursor(cx, cy);
    let status = show_scroll_status(app, (mx + x as i32, my + y as i32, w, h));

    // Esc stops early and keeps what has been captured.
    let gs = app.global_shortcut();
    let stop_app = app.clone();
    let esc_ok = gs
        .on_shortcut("Escape", move |_a, _s, ev| {
            if ev.state == ShortcutState::Pressed {
                stop_app.state::<AppState>().stop_scroll.store(true, Ordering::SeqCst);
            }
        })
        .is_ok();

    let mut io = WinIo { monitor, x, y, w, h, cx, cy, app: app.clone() };
    let result = stitch::run(&mut io, SCROLL_MAX_PIXELS);

    if esc_ok {
        let _ = gs.unregister("Escape");
    }
    if let Some(win) = status {
        let _ = win.destroy();
    }
    winput::move_cursor(before.0, before.1);

    let (img, why) = result?;
    let one_view = img.h <= h as usize;
    let note = match why {
        stitch::Stop::EndReached => None,
        stitch::Stop::UserStopped => Some("Stopped. Kept everything captured so far.".to_string()),
        stitch::Stop::SizeLimit => Some("Reached the maximum size (about 40 megapixels). The picture ends there.".to_string()),
        stitch::Stop::NoScroll => {
            return Err("Nothing scrolled. Select the part of the page that scrolls with the mouse wheel, and start with the pointer over it.".into());
        }
        stitch::Stop::LostTrack => {
            if one_view {
                return Err("Could not follow the scrolling. Select only the part that scrolls (without fixed side bars) and try again.".into());
            }
            Some("Stopped early because Snipzi lost track of the scrolling (moving or animated content?). Kept what was captured.".to_string())
        }
    };
    Ok((Frame { x: mx, y: my, w: img.w as u32, h: img.h as u32, rgba: img.rgba }, note))
}

// ---------------------------------------------------------------------------
// Editor window (reopen a saved capture and annotate it)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn open_editor(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("editor") {
        let _ = app.emit_to("editor", "editor:load", ());
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "editor", WebviewUrl::App("overlay.html?editor=1".into()))
        .title("Snipzi editor")
        .inner_size(1100.0, 760.0)
        .min_inner_size(640.0, 420.0)
        .center()
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The editor finished: tell the main window what to save, then close the editor.
#[tauri::command]
fn editor_done(app: AppHandle, result: Value) {
    let _ = app.emit_to("main", "editor:done", result);
    if let Some(w) = app.get_webview_window("editor") {
        let _ = w.destroy();
    }
}

#[tauri::command]
fn close_editor(app: AppHandle) {
    if let Some(w) = app.get_webview_window("editor") {
        let _ = w.destroy();
    }
}

/// Reads an image file from disk for the editor (old History entries have no stored copy).
#[tauri::command]
fn read_image_file(path: String) -> Result<Response, String> {
    let lower = path.to_lowercase();
    if !(lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg") || lower.ends_with(".webp")) {
        return Err("Only PNG, JPEG and WebP files can be edited.".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read the file: {e}"))?;
    Ok(Response::new(bytes))
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
    let upload = mode == "upload";
    let real_mode = if upload { "region".to_string() } else { mode };
    begin_capture(&app, &real_mode, delay, upload);
}

#[derive(Deserialize)]
struct OptionsArg {
    edit_before_save: bool,
    delay_secs: u32,
    keep_overlays: bool,
}

#[tauri::command]
fn set_options(app: AppHandle, options: OptionsArg) {
    let keep_before;
    {
        let state = app.state::<AppState>();
        let mut o = state.opts.lock().unwrap();
        keep_before = o.keep_overlays;
        o.edit_before_save = options.edit_before_save;
        o.delay_secs = options.delay_secs.min(60);
        o.keep_overlays = options.keep_overlays;
    }
    if keep_before != options.keep_overlays {
        let app2 = app.clone();
        std::thread::spawn(move || {
            let busy = app2.state::<AppState>().cap.lock().unwrap().busy;
            if busy {
                return;
            }
            if options.keep_overlays {
                let n = xcap::Monitor::all().map(|m| m.len()).unwrap_or(1).max(1);
                let _ = ensure_overlays(&app2, n);
            } else {
                destroy_overlays(&app2);
            }
        });
    }
}

#[tauri::command]
fn get_countdown(state: tauri::State<AppState>) -> u32 {
    state.cap.lock().unwrap().countdown
}

// ----- post-capture pop-up -----

#[tauri::command]
async fn show_popup(app: AppHandle, payload: Value) -> Result<(), String> {
    *app.state::<AppState>().popup.lock().unwrap() = Some(payload);
    let (w, h) = (340.0, 232.0);
    if let Some(win) = app.get_webview_window("popup") {
        place_on_cursor_monitor(&app, &win, w, h, true);
        let _ = win.show();
        let _ = app.emit_to("popup", "popup:update", ());
        return Ok(());
    }
    let win = helper_window(&app, "popup", "popup.html", w, h)?;
    place_on_cursor_monitor(&app, &win, w, h, true);
    let _ = win.show();
    Ok(())
}

#[tauri::command]
fn get_popup(state: tauri::State<AppState>) -> Option<Value> {
    state.popup.lock().unwrap().clone()
}

#[tauri::command]
fn popup_action(app: AppHandle, action: String) {
    let _ = app.emit_to("main", "popup:action", action);
}

#[tauri::command]
fn close_popup(app: AppHandle) {
    if let Some(w) = app.get_webview_window("popup") {
        let _ = w.destroy();
    }
}

// ----- folders -----

#[tauri::command]
async fn pick_folder(app: AppHandle, start: Option<String>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file();
    if let Some(s) = start.filter(|s| !s.trim().is_empty()) {
        dialog = dialog.set_directory(s);
    }
    dialog
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn open_save_folder(app: AppHandle, dir: String) -> Result<(), String> {
    let path = if dir.trim().is_empty() { default_save_dir(&app) } else { PathBuf::from(dir.trim()) };
    std::fs::create_dir_all(&path).map_err(|e| format!("Could not create the folder: {e}"))?;
    app.opener().open_path(path.to_string_lossy().to_string(), None::<&str>).map_err(|e| e.to_string())
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

#[derive(Deserialize)]
struct HotkeyArgs {
    region: String,
    screen: String,
    window: String,
    upload: String,
    #[serde(default)]
    scroll: String,
    #[serde(default)]
    picker: String,
    #[serde(default)]
    ruler: String,
}

impl HotkeyArgs {
    fn defaults() -> HotkeyArgs {
        HotkeyArgs {
            region: DEFAULT_REGION_KEY.into(),
            screen: DEFAULT_SCREEN_KEY.into(),
            window: DEFAULT_WINDOW_KEY.into(),
            upload: DEFAULT_UPLOAD_KEY.into(),
            scroll: DEFAULT_SCROLL_KEY.into(),
            picker: DEFAULT_PICKER_KEY.into(),
            ruler: DEFAULT_RULER_KEY.into(),
        }
    }
}

#[tauri::command]
fn set_hotkeys(app: AppHandle, keys: HotkeyArgs) -> Result<(), String> {
    register_hotkeys(&app, &keys)
}

fn register_hotkeys(app: &AppHandle, keys: &HotkeyArgs) -> Result<(), String> {
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    let jobs: [(&str, &str, &str, bool); 7] = [
        (&keys.region, "region", "region capture", false),
        (&keys.screen, "screen", "screen capture", false),
        (&keys.window, "window", "window capture", false),
        (&keys.upload, "region", "capture and upload", true),
        (&keys.scroll, "scroll", "scrolling capture", false),
        (&keys.picker, "picker", "colour picker", false),
        (&keys.ruler, "ruler", "ruler", false),
    ];
    for (key, mode, label, up) in jobs {
        if key.trim().is_empty() {
            continue;
        }
        gs.on_shortcut(key, move |app, _s, ev| {
            if ev.state == ShortcutState::Pressed {
                begin_capture(app, mode, 0, up);
            }
        })
        .map_err(|e| format!("Could not use \"{key}\" for {label}: {e}"))?;
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
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_frame,
            release_frames,
            overlay_loaded,
            overlay_ready,
            finish_region,
            finish_pick,
            cancel_capture,
            get_scroll_status,
            open_editor,
            editor_done,
            close_editor,
            read_image_file,
            start_capture,
            get_default_save_dir,
            save_file,
            copy_image,
            copy_text,
            open_path,
            reveal_path,
            open_url,
            notify_user,
            set_hotkeys,
            set_options,
            get_countdown,
            show_popup,
            get_popup,
            popup_action,
            close_popup,
            pick_folder,
            open_save_folder,
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
            let m_window = MenuItem::with_id(app, "window", "Capture window", true, None::<&str>)?;
            let m_screen = MenuItem::with_id(app, "screen", "Capture screen", true, None::<&str>)?;
            let m_scroll = MenuItem::with_id(app, "scroll", "Scrolling capture", true, None::<&str>)?;
            let m_picker = MenuItem::with_id(app, "picker", "Colour picker", true, None::<&str>)?;
            let m_ruler = MenuItem::with_id(app, "ruler", "Ruler", true, None::<&str>)?;
            let m_open = MenuItem::with_id(app, "open", "Open Snipzi", true, None::<&str>)?;
            let m_quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&m_region, &m_window, &m_screen, &m_scroll, &m_picker, &m_ruler, &m_open, &m_quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("Snipzi")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "region" => begin_capture(app, "region", 150, false),
                    "window" => begin_capture(app, "window", 150, false),
                    "screen" => begin_capture(app, "screen", 150, false),
                    "scroll" => begin_capture(app, "scroll", 150, false),
                    "picker" => begin_capture(app, "picker", 150, false),
                    "ruler" => begin_capture(app, "ruler", 150, false),
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
            if let Err(e) = register_hotkeys(&handle, &HotkeyArgs::defaults()) {
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
