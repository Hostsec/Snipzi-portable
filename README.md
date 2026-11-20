# Snipzi for Windows

Quick screenshots of your whole screen or any part of it. Snipzi lives in the system tray, so a capture is one shortcut away.

## What it does

- **Capture region**: press the shortcut, drag a box, done. Works across several monitors.
- **Capture screen**: grabs the whole monitor your mouse is on.
- **Hide areas before saving** (optional): after dragging a region, draw solid black boxes over anything private. Click a box to remove it.
- **Watermark** (optional): a single centered stamp or a tiled pattern, with adjustable opacity.
- **Editor** after you select an area (turn on "Edit before saving", or hold Shift when you let go): resize or move the area, then add arrows, boxes, circles, pen, highlight, text, numbered markers, blur or a solid black hide box.
- **Window capture**, **delay timer** (3, 5 or 10 seconds, for menus and tooltips), an optional **pop-up** after each capture, a folder picker, and a **fast capture** switch you can turn off to save memory.
- **Scrolling capture**: select the part of a page or list that scrolls, and Snipzi scrolls it with the mouse wheel and stitches one long picture. Sticky headers and footers are kept once, Esc stops early, and it ends by itself at the bottom. Scroll to the top first, select only the scrolling part, and keep the mouse still while it runs.
- **Colour picker**: a magnifier follows the pointer, click copies the colour as HEX, RGB or HSL, and recent colours are kept on the Capture tab.
- **Ruler**: drag to measure width, height and diagonal in real pixels; arrow keys fine-tune and C copies the size.
- **Edit later**: the Edit button on the Last screenshot panel and on every History entry reopens the picture in an editor window with zoom. Saving always makes a new file and leaves the original alone.
- **Save as** PNG, JPEG, WebP or PDF, with your own file name pattern and subfolders.
- **Copy to clipboard** and **save to a file**, either or both.
- **History** of your last 20 captures.
- **Upload to ImgBay** with one click (or automatically), and the link is copied for you.

## Default shortcuts

| Action | Shortcut |
|---|---|
| Capture region | Ctrl+Shift+1 |
| Capture screen | Ctrl+Shift+2 |
| Capture window (click it) | Ctrl+Shift+3 |
| Capture region and upload to ImgBay | Ctrl+Shift+4 |
| Scrolling capture | Ctrl+Shift+5 |
| Colour picker | Ctrl+Shift+6 |
| Ruler | Ctrl+Shift+7 |

Change them in Settings: click the box and press the keys you want. Windows reserves PrintScreen for the Snipping Tool by default. To use it here, turn that off in Windows Settings under Accessibility, Keyboard.

## Getting the app (no coding needed)

1. Create a free GitHub account if you do not have one, then create a new empty repository.
2. Upload the contents of this folder to it (the `.github` folder must be included).
3. Open the **Actions** tab, choose **Build Windows app**, and click **Run workflow**.
4. When it finishes (about 10 minutes the first time), open the run and download **snipzi-windows-vX.Y.Z** (the version is in the name).
5. Inside are two files: an installer (`Snipzi_..._setup.exe`) and `Snipzi-portable-vX.Y.Z.exe`. Use either one.

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
