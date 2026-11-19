# Snipzi for Windows

Quick screenshots of your whole screen or any part of it. Snipzi lives in the system tray, so a capture is one shortcut away.

## What it does

- **Capture region**: press the shortcut, drag a box, done. Works across several monitors.
- **Capture screen**: grabs the whole monitor your mouse is on.
- **Hide areas before saving** (optional): after dragging a region, draw solid black boxes over anything private. Click a box to remove it.
- **Watermark** (optional): a single centered stamp or a tiled pattern, with adjustable opacity.
- **Save as** PNG, JPEG, WebP or PDF, with your own file name pattern and subfolders.
- **Copy to clipboard** and **save to a file**, either or both.
- **History** of your last 20 captures.
- **Upload to ImgBay** with one click (or automatically), and the link is copied for you.

## Default shortcuts

| Action | Shortcut |
|---|---|
| Capture region | Ctrl+Shift+1 |
| Capture screen | Ctrl+Shift+2 |

Change them in Settings: click the box and press the keys you want. Windows reserves PrintScreen for the Snipping Tool by default. To use it here, turn that off in Windows Settings under Accessibility, Keyboard.

## Getting the app (no coding needed)

1. Create a free GitHub account if you do not have one, then create a new empty repository.
2. Upload the contents of this folder to it (the `.github` folder must be included).
3. Open the **Actions** tab, choose **Build Windows app**, and click **Run workflow**.
4. When it finishes (about 10 minutes the first time), open the run and download **snipzi-windows**.
5. Inside are two files: an installer (`Snipzi_..._setup.exe`) and `Snipzi-portable.exe`. Use either one.

To publish a numbered release instead, push a tag such as `v0.1.0`. The files then appear under Releases.

Windows may show a "Windows protected your PC" notice because the app is not code signed. Choose **More info**, then **Run anyway**.

## Using ImgBay

1. In Settings, type your ImgBay address.
2. Click **Log in to ImgBay**, sign in with **Remember me** ticked, and close that window.
3. Click **Check login**. After that, use **Upload to ImgBay** on the Capture tab, or tick the automatic option.

## Good to know

- Closing the window keeps Snipzi running in the tray. Quit from the tray icon menu.
- Starting Snipzi with Windows is an option in Settings.
- Fast start: the capture overlays are prepared in the background, which uses some memory while Snipzi runs.
- Protected video (some streaming apps) may appear black in any screenshot tool.
- If a shortcut does not work, another app may already use it. Pick a different one.

## For developers

Tauri 2 (Rust) backend in `src-tauri`, plain HTML and JavaScript frontend in `src`. Run `npm install` then `npm run tauri dev` on Windows with Rust installed. Frontend tests: `python3 tests/test_frontend.py` (needs Playwright with Chromium).
