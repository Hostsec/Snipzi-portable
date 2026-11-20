"""Headless Chromium tests for the Snipzi desktop frontend (main window pipeline + overlay).
The Tauri bridge is mocked; the real src/ files run unmodified.
Run: python3 tests/test_frontend.py"""
import base64, json, subprocess, sys, threading, http.server, functools, os, tempfile
from playwright.sync_api import sync_playwright

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=SRC)
handler.log_message = lambda *a, **k: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}"

MOCK = """
window.__calls = []; window.__listeners = {}; window.__saved = []; window.__clip = [];
window.__FRAME = {w: 400, h: 300};
window.__mock = async (cmd, args, opts) => {
  if (cmd === 'get_frame') {
    const {w, h} = window.__FRAME;
    const buf = new ArrayBuffer(8 + w*h*4); const dv = new DataView(buf);
    dv.setUint32(0, w, true); dv.setUint32(4, h, true);
    const px = new Uint8Array(buf, 8);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y*w+x)*4; px[i] = x % 256; px[i+1] = y % 256; px[i+2] = 128; px[i+3] = 255; }
    return buf;
  }
  if (cmd === 'save_file') {
    const rel = atob(opts.headers['x-path']);
    window.__saved.push({rel, bytes: Array.from(args)});
    return 'C:\\\\Users\\\\t\\\\Pictures\\\\Snipzi\\\\' + rel.split('/').pop();
  }
  if (cmd === 'copy_image') { window.__clip.push({w: opts.headers['x-w'], h: opts.headers['x-h'], len: args.length, p0: Array.from(args.slice(0,4))}); return null; }
  if (cmd === 'get_default_save_dir') return 'C:\\\\Users\\\\t\\\\Pictures\\\\Snipzi';
  if (cmd === 'get_autostart') return false;
  return null;
};
window.__TAURI__ = {
  core: { invoke: async (cmd, args, opts) => { window.__calls.push({cmd, args: (args instanceof Uint8Array ? '[bytes]' : args), headers: opts && opts.headers}); return window.__mock(cmd, args, opts); } },
  event: { listen: (name, cb) => { (window.__listeners[name] = window.__listeners[name] || []).push(cb); return Promise.resolve(() => {}); } }
};
"""

fails = []
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if (extra and not cond) else ""))
    if not cond: fails.append(name)

DECODE = """async (bytes) => {
  const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
  const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
  return {w: bmp.width, h: bmp.height, px: (a, b) => Array.from(x.getImageData(a, b, 1, 1).data)};
}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 800, "height": 600})
    ctx.add_init_script(MOCK)
    errors = []

    # ---------------- main window ----------------
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(BASE + "/index.html")
    pg.wait_for_function("window.__snipzi !== undefined")
    check("set_hotkeys called on startup", any(c["cmd"] == "set_hotkeys" for c in pg.evaluate("window.__calls")))

    # 1. default region capture with a redaction box
    pg.evaluate("window.__snipzi.handleRegion({idx:0,x:10,y:20,w:100,h:50,shapes:[{t:'hide',x:10,y:20,w:20,h:20}]})")
    saved = pg.evaluate("window.__saved")
    check("region: one file saved", len(saved) == 1)
    rel = saved[0]["rel"]
    import re
    check("region: default file name", re.fullmatch(r"snipzi-region-\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.png", rel) is not None, rel)
    check("region: PNG magic", bytes(saved[0]["bytes"][:8]) == b"\x89PNG\r\n\x1a\n")
    info = pg.evaluate("""async (bytes) => { const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
        const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp,0,0);
        return {w: bmp.width, h: bmp.height, inside: Array.from(x.getImageData(30,10,1,1).data), redacted: Array.from(x.getImageData(5,5,1,1).data), edge: Array.from(x.getImageData(25,5,1,1).data)}; }""", saved[0]["bytes"])
    check("region: cropped size 100x50", (info["w"], info["h"]) == (100, 50), str(info))
    check("region: crop offset correct (r=x+10, g=y+20)", info["inside"][:3] == [40, 30, 128], str(info["inside"]))
    check("region: redaction box is solid black", info["redacted"] == [0, 0, 0, 255], str(info["redacted"]))
    check("region: pixel just outside redaction is untouched", info["edge"][:3] == [35, 25, 128], str(info["edge"]))
    clip = pg.evaluate("window.__clip")
    check("region: clipboard got 100x50 RGBA", len(clip) == 1 and clip[0]["w"] == "100" and clip[0]["h"] == "50" and clip[0]["len"] == 20000, str(clip))
    last = pg.evaluate("JSON.parse(localStorage.getItem('snipziLast'))")
    check("region: last record has dimensions and size", last["dimensions"] == {"width": 100, "height": 50} and last["fileSizeBytes"] > 100, str(last)[:200])
    check("region: history has 1 entry", pg.evaluate("JSON.parse(localStorage.getItem('snipziHistory')).length") == 1)

    # 2. jpeg + watermark + folder/filename templates, no clipboard
    pg.evaluate("""window.__snipzi.setSettings({format:'jpeg', quality:0.8, watermarkEnabled:true, watermarkText:'Confidential', watermarkStyle:'tiled',
        folderTemplate:'Shots/{year}/../{type}', filenameTemplate:'{type}-{date}-x', copyToClipboard:false})""")
    pg.evaluate("window.__snipzi.handleScreen({idx:0})")
    saved = pg.evaluate("window.__saved")
    rel2 = saved[1]["rel"]
    check("screen: folder template, '..' stripped", re.fullmatch(r"Shots/\d{4}/screen/screen-\d{4}-\d\d-\d\d-x\.jpg", rel2) is not None, rel2)
    check("screen: JPEG magic", bytes(saved[1]["bytes"][:3]) == b"\xff\xd8\xff")
    wm = pg.evaluate("""async (bytes) => { const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
        const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp,0,0);
        const d = x.getImageData(0,0,bmp.width,bmp.height).data; let changed = 0;
        for (let y = 0; y < bmp.height; y += 3) for (let xx = 0; xx < bmp.width; xx += 3) { const i = (y*bmp.width+xx)*4;
          if (Math.abs(d[i+2]-128) > 10) changed++; }
        return {w: bmp.width, h: bmp.height, changed}; }""", saved[1]["bytes"])
    check("screen: full 400x300 frame", (wm["w"], wm["h"]) == (400, 300))
    check("screen: watermark visibly changed pixels", wm["changed"] > 400, str(wm))
    check("screen: no clipboard call when disabled", len(pg.evaluate("window.__clip")) == 1)

    # 3. PDF
    pg.evaluate("window.__snipzi.setSettings({format:'pdf', watermarkEnabled:false, folderTemplate:'', filenameTemplate:''})")
    pg.evaluate("window.__snipzi.handleRegion({idx:0,x:0,y:0,w:200,h:100,shapes:[]})")
    saved = pg.evaluate("window.__saved")
    pdf = bytes(saved[2]["bytes"]); check("pdf: file name ends .pdf", saved[2]["rel"].endswith(".pdf"))
    tmp = tempfile.mkdtemp(); path = os.path.join(tmp, "t.pdf"); open(path, "wb").write(pdf)
    r = subprocess.run(["qpdf", "--check", path], capture_output=True, text=True)
    check("pdf: qpdf --check passes", r.returncode == 0, r.stdout + r.stderr)
    subprocess.run(["pdftoppm", "-png", "-r", "96", path, os.path.join(tmp, "out")], check=True)
    pngs = [f for f in os.listdir(tmp) if f.endswith(".png")]
    check("pdf: renders to an image", len(pngs) == 1)
    from PIL import Image
    im = Image.open(os.path.join(tmp, pngs[0])).convert("RGB")
    check("pdf: rendered page is 200x100 px at 96 dpi", abs(im.size[0] - 200) <= 2 and abs(im.size[1] - 100) <= 2, str(im.size))
    px = im.getpixel((50, 30))
    check("pdf: rendered pixel matches source (approx r=50,g=30)", abs(px[0] - 50) < 12 and abs(px[1] - 30) < 12 and abs(px[2] - 128) < 12, str(px))

    # 4. history toggle off => no new entry; but last always updates
    n_before = pg.evaluate("JSON.parse(localStorage.getItem('snipziHistory')).length")
    pg.evaluate("window.__snipzi.setSettings({historyEnabled:false, format:'png'})")
    pg.evaluate("window.__snipzi.handleScreen({idx:0})")
    check("history off: no new entry", pg.evaluate("JSON.parse(localStorage.getItem('snipziHistory')).length") == n_before)
    check("history off: last record still updated", pg.evaluate("JSON.parse(localStorage.getItem('snipziLast')).dimensions.width") == 400)

    # 5. not saving to file: record has no path
    pg.evaluate("window.__snipzi.setSettings({saveToFile:false, historyEnabled:true})")
    saved_n = len(pg.evaluate("window.__saved")); pg.evaluate("window.__snipzi.handleScreen({idx:0})")
    check("save off: nothing written", len(pg.evaluate("window.__saved")) == saved_n)
    check("save off: Open button disabled", pg.evaluate("document.getElementById('last-open').disabled") is True)

    # 5b. dismiss the last-screenshot panel: no file is touched, history entry stays
    pg.evaluate("window.__snipzi.setSettings({saveToFile:true, historyEnabled:true})")
    pg.evaluate("window.__snipzi.handleScreen({idx:0})")
    hist_n = pg.evaluate("JSON.parse(localStorage.getItem('snipziHistory')).length")
    pg.evaluate("window.__calls.length = 0")
    pg.evaluate("document.getElementById('last-dismiss').click()"); pg.wait_for_timeout(100)
    check("dismiss: panel hidden and record cleared", pg.evaluate("localStorage.getItem('snipziLast')") is None and pg.evaluate("document.getElementById('last-card').classList.contains('hidden')"))
    check("dismiss: no native calls (file untouched)", pg.evaluate("window.__calls.length") == 0)
    check("dismiss: history entry kept", pg.evaluate("JSON.parse(localStorage.getItem('snipziHistory')).length") == hist_n)

    # 6. hotkey capture box
    pg.evaluate("window.__calls.length = 0")
    pg.click("#hk-region") if False else None
    pg.evaluate("document.querySelector('.tab[data-view=settings]').click()")
    pg.evaluate("""document.getElementById('hk-region').dispatchEvent(new KeyboardEvent('keydown', {code:'KeyS', key:'s', ctrlKey:true, shiftKey:true, bubbles:true, cancelable:true}))""")
    pg.wait_for_timeout(200)
    hk = [c for c in pg.evaluate("window.__calls") if c["cmd"] == "set_hotkeys"]
    check("hotkey: Ctrl+Shift+S registered", hk and hk[-1]["args"]["keys"]["region"] == "Ctrl+Shift+S", str(hk))
    pg.evaluate("""document.getElementById('hk-screen').dispatchEvent(new KeyboardEvent('keydown', {code:'KeyA', key:'a', bubbles:true, cancelable:true}))""")
    pg.wait_for_timeout(100)
    check("hotkey: bare letter rejected", "at least one" in pg.evaluate("document.getElementById('hk-error').textContent"))
    pg.evaluate("""document.getElementById('hk-screen').dispatchEvent(new KeyboardEvent('keydown', {code:'PrintScreen', key:'PrintScreen', bubbles:true, cancelable:true}))""")
    pg.wait_for_timeout(100)
    check("hotkey: bare PrintScreen allowed", pg.evaluate("JSON.parse(localStorage.getItem('snipziSettings')).hotkeyScreen") == "PrintScreen")

    # 7. settings form persists
    pg.evaluate("""const el = document.getElementById('s-watermarkText'); el.value = 'Draft'; el.dispatchEvent(new Event('input', {bubbles:true}))""")
    check("settings: text persisted", pg.evaluate("JSON.parse(localStorage.getItem('snipziSettings')).watermarkText") == "Draft")
    check("main page: no JS errors", not errors, str(errors))
    pg.close()


    # ---------------- ImgBay (fake server responses through the mocked Rust bridge) ----------------
    ib = ctx.new_page(); ierr = []; ib.on("pageerror", lambda e: ierr.append(str(e)))
    ib.goto(BASE + "/index.html"); ib.wait_for_function("window.__snipzi !== undefined")
    ib.evaluate("""(() => {
      const orig = window.__mock; window.__http = [];
      window.__mock = async (cmd, args, opts) => {
        if (cmd === 'http_request') {
          const a = args.args; window.__http.push(a);
          if (a.method === 'GET' && a.url.endsWith('?page=gallery')) return {status: 200, body: '<form><input type="hidden" name="a" value="upload"><input type="hidden" name="t" value="TOK123"></form>'};
          if (a.method === 'POST') return {status: 200, body: '<div class="flash ok" role="status">Uploaded</div><a href="?page=image&amp;id=abcdefghijkl">x</a>'};
          if (a.url.includes('?page=image&id=abcdefghijkl')) return {status: 200, body: '<input readonly value="https://img.example.com/imgbay/i/abcdefghijkl.png"><input readonly value="https://img.example.com/imgbay/view.php?id=abcdefghijkl">'};
          return {status: 404, body: ''};
        }
        return orig(cmd, args, opts);
      };
    })()""")
    ib.evaluate("window.__snipzi.setSettings({imgbayUrl:'img.example.com/imgbay/index.php', imgbayExpiry:'14d', imgbayVisibility:'private'})")
    ib.evaluate("window.__snipzi.handleScreen({idx:0})")
    ib.evaluate("document.getElementById('last-upload').click()")
    ib.wait_for_function("window.__calls.some(c => c.cmd === 'copy_text')", timeout=8000)
    post = [h for h in ib.evaluate("window.__http") if h["method"] == "POST"][0]
    fields = {k: v for k, v in post["fields"]}
    check("imgbay: upload form fields", fields == {"a": "upload", "t": "TOK123", "exp": "14d", "views": "0", "vis": "private"}, str(fields))
    check("imgbay: file part is the PNG", post["file"]["name"] == "imgs[]" and base64.b64decode(post["file"]["b64"])[:4] == b"\x89PNG", str(post["file"])[:120])
    check("imgbay: base address normalised", post["url"] == "https://img.example.com/imgbay/", post["url"])
    cp = [c for c in ib.evaluate("window.__calls") if c["cmd"] == "copy_text"][0]
    check("imgbay: direct link copied", cp["args"]["text"] == "https://img.example.com/imgbay/i/abcdefghijkl.png", str(cp))
    check("imgbay: link stored with last screenshot", ib.evaluate("JSON.parse(localStorage.getItem('snipziLast')).imgbay.pageUrl") == "https://img.example.com/imgbay/view.php?id=abcdefghijkl")
    check("imgbay: no JS errors", not ierr, str(ierr))
    ib.close()

    # ---------------- overlay ----------------
    def open_overlay(payload=None):
        ov = ctx.new_page()
        oerr = []; ov.on("pageerror", lambda e: oerr.append(str(e)))
        ov.goto(BASE + "/overlay.html?i=0")
        ov.evaluate("window.__FRAME = {w: 1600, h: 1200}")
        ov.wait_for_function("window.__calls.some(c => c.cmd === 'overlay_loaded')")
        pl = {"idx": 0, "mode": "region", "edit": False, "upload": False, "windows": []}
        pl.update(payload or {})
        ov.evaluate("(pl) => window.__listeners['overlay:frame'].forEach(cb => cb({payload: pl}))", pl)
        ov.wait_for_function("window.__calls.some(c => c.cmd === 'overlay_ready')")
        return ov, oerr
    def rearm(ov, payload=None):
        ov.evaluate("window.__calls.length = 0")
        pl = {"idx": 0, "mode": "region", "edit": False, "upload": False, "windows": []}
        pl.update(payload or {})
        ov.evaluate("(pl) => window.__listeners['overlay:frame'].forEach(cb => cb({payload: pl}))", pl)
        ov.wait_for_function("window.__calls.some(c => c.cmd === 'overlay_ready')")
    def finished(ov):
        ov.wait_for_function("window.__calls.some(c => c.cmd === 'finish_region')")
        return [c for c in ov.evaluate("window.__calls") if c["cmd"] == "finish_region"][0]["args"]["result"]
    def drag(ov, a, b, shift=False):
        ov.mouse.move(*a); ov.mouse.down(); ov.mouse.move(*b, steps=4)
        if shift: ov.keyboard.down("Shift")
        ov.mouse.up()
        if shift: ov.keyboard.up("Shift")
    def bar_visible(ov): return ov.evaluate("getComputedStyle(document.getElementById('bar')).display") != "none"

    ov, oerr = open_overlay()
    check("overlay: painted frame at physical size", ov.evaluate("[document.getElementById('frame').width, document.getElementById('frame').height]") == [1600, 1200])
    check("overlay: hint mentions Space and Shift", "Space" in ov.evaluate("document.getElementById('hint').textContent") and "Shift" in ov.evaluate("document.getElementById('hint').textContent"))
    drag(ov, (100, 100), (300, 250))
    res = finished(ov)
    check("overlay: instant save, CSS to physical scaling (x2)", (res["x"], res["y"], res["w"], res["h"]) == (200, 200, 400, 300), str(res))
    check("overlay: instant save has no shapes and no upload", res["shapes"] == [] and res["upload"] is False)
    rearm(ov)
    ov.mouse.click(50, 50)
    check("overlay: stray click does not finish or cancel", not any(c["cmd"] in ("finish_region", "cancel_capture") for c in ov.evaluate("window.__calls")))
    ov.keyboard.press("Escape"); ov.wait_for_function("window.__calls.some(c => c.cmd === 'cancel_capture')")
    check("overlay: Escape cancels", True)
    rearm(ov)
    ov.mouse.click(60, 60, button="right"); ov.wait_for_function("window.__calls.some(c => c.cmd === 'cancel_capture')")
    check("overlay: right-click cancels", True)

    # Shift on release opens the editor once; handles, move, nudge
    rearm(ov)
    drag(ov, (100, 100), (400, 300), shift=True)
    check("editor: Shift on release opens toolbar and does not save", bar_visible(ov) and not any(c["cmd"] == "finish_region" for c in ov.evaluate("window.__calls")))
    check("editor: 8 handles exist", ov.evaluate("document.querySelectorAll('#sel .h').length") == 8)
    ov.mouse.move(250, 200); ov.mouse.down(); ov.mouse.move(300, 230, steps=3); ov.mouse.up()
    ov.keyboard.press("ArrowRight"); ov.keyboard.press("Shift+ArrowDown")
    # move by (50,30) css = (100,60) px, plus nudge (1,10)
    ov.keyboard.press("Enter"); res = finished(ov)
    check("editor: drag inside moves selection, arrows nudge", (res["x"], res["y"], res["w"], res["h"]) == (301, 270, 600, 400), str(res))

    # resize with a handle
    rearm(ov)
    drag(ov, (100, 100), (400, 300), shift=True)
    box = ov.evaluate("(() => { const r = document.querySelector('#sel .h-se').getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; })()")
    ov.mouse.move(*box); ov.mouse.down(); ov.mouse.move(box[0] + 50, box[1] + 25, steps=3); ov.mouse.up()
    ov.click("#save"); res = finished(ov)
    check("editor: SE handle resizes", (res["x"], res["y"], res["w"], res["h"]) == (200, 200, 700, 450), str(res))

    # tools produce shapes in monitor pixels, relative to the whole frame
    rearm(ov, {"edit": True})
    check("editor: edit setting opens toolbar after drag", True)
    drag(ov, (100, 100), (500, 300))
    check("editor: edit-before-save shows toolbar", bar_visible(ov))
    ov.click("[data-tool=hide]"); drag(ov, (120, 120), (220, 180))
    ov.click("[data-tool=blur]"); drag(ov, (250, 120), (350, 180))
    ov.click("[data-tool=arrow]"); drag(ov, (130, 200), (300, 250))
    ov.click("[data-tool=step]"); ov.mouse.click(400, 200); ov.mouse.click(420, 200)
    ov.click("[data-tool=rect]"); drag(ov, (130, 230), (200, 280))
    ov.click("[data-tool=text]"); ov.mouse.click(250, 230); ov.wait_for_selector(".txt:focus"); ov.keyboard.type("Hi"); ov.keyboard.press("Enter")
    ov.click("#undo")   # drops the text
    ov.click("#saveup"); res = finished(ov)
    kinds = [x["t"] for x in res["shapes"]]
    check("editor: shapes recorded in order, undo removes last", kinds == ["hide", "blur", "arrow", "step", "step", "rect"], str(kinds))
    check("editor: hide box in monitor pixels", (res["shapes"][0]["x"], res["shapes"][0]["y"], res["shapes"][0]["w"], res["shapes"][0]["h"]) == (240, 240, 200, 120), str(res["shapes"][0]))
    check("editor: steps numbered 1 and 2", [x["n"] for x in res["shapes"] if x["t"] == "step"] == [1, 2])
    check("editor: Save and upload sets upload flag", res["upload"] is True)

    # drawing outside the selection is ignored, Esc inside text cancels only the text
    rearm(ov)
    drag(ov, (100, 100), (300, 300), shift=True)
    ov.click("[data-tool=hide]"); drag(ov, (500, 500), (600, 550))
    ov.click("[data-tool=text]"); ov.mouse.click(150, 150); ov.wait_for_selector(".txt:focus"); ov.keyboard.type("x"); ov.keyboard.press("Escape")
    check("editor: Esc in text box does not cancel the capture", not any(c["cmd"] == "cancel_capture" for c in ov.evaluate("window.__calls")))
    ov.keyboard.press("Enter"); res = finished(ov)
    check("editor: outside drawing ignored, empty text dropped", res["shapes"] == [], str(res["shapes"]))

    # Space = whole screen straight into the editor
    rearm(ov)
    ov.keyboard.press("Space")
    check("editor: Space opens editor on whole screen", bar_visible(ov))
    ov.keyboard.press("Enter"); res = finished(ov)
    check("editor: Space selects whole screen", (res["x"], res["y"], res["w"], res["h"]) == (0, 0, 1600, 1200), str(res))

    # Space held during drag moves the selection
    rearm(ov)
    ov.mouse.move(100, 100); ov.mouse.down(); ov.mouse.move(200, 200, steps=3)
    ov.keyboard.down("Space"); ov.mouse.move(300, 300, steps=3); ov.keyboard.up("Space"); ov.mouse.up()
    res = finished(ov)
    check("overlay: Space while dragging moves the selection", (res["x"], res["y"], res["w"], res["h"]) == (400, 400, 200, 200), str(res))

    # window mode
    rearm(ov, {"mode": "window", "windows": [{"x": 200, "y": 100, "w": 800, "h": 600, "title": "Notepad"}]})
    check("window mode: hint says click a window", "Click a window" in ov.evaluate("document.getElementById('hint').textContent"))
    ov.mouse.move(300, 200)
    check("window mode: hover shows title", "Notepad" in ov.evaluate("document.getElementById('tag').textContent"))
    ov.mouse.click(300, 200); res = finished(ov)
    check("window mode: click selects that window", (res["x"], res["y"], res["w"], res["h"]) == (200, 100, 800, 600), str(res))
    rearm(ov, {"mode": "window", "windows": []})
    ov.mouse.click(300, 200); res = finished(ov)
    check("window mode: no window under cursor takes the whole monitor", (res["w"], res["h"]) == (1600, 1200), str(res))

    check("overlay: no JS errors", not oerr, str(oerr))
    ov.close()

    # ---------------- main window: new handlers ----------------
    m = ctx.new_page(); merr = []; m.on("pageerror", lambda e: merr.append(str(e)))
    m.goto(BASE + "/index.html"); m.wait_for_function("window.__snipzi !== undefined")
    m.evaluate("window.__snipzi.setSettings({imgbayUrl:'', popupEnabled:true, popupSeconds:9})")
    m.evaluate("window.__snipzi.handleRegion({idx:0,x:0,y:0,w:50,h:50,shapes:[],kind:'window',upload:true})")
    saved = m.evaluate("window.__saved")
    check("window capture: file named with type window", "-window-" in saved[-1]["rel"], saved[-1]["rel"])
    pu = [c for c in m.evaluate("window.__calls") if c["cmd"] == "show_popup"]
    check("popup: shown when enabled, with stay time", pu and pu[-1]["args"]["payload"]["seconds"] == 9, str(pu)[:200])
    check("popup: no native notification when popup is on", not any(c["cmd"] == "notify_user" and "Saved" in c["args"]["body"] and "not uploaded" not in c["args"]["body"] for c in m.evaluate("window.__calls")))
    check("upload without ImgBay address: warns but still saves", any(c["cmd"] == "notify_user" and "not uploaded" in c["args"]["body"] for c in m.evaluate("window.__calls")))
    m.evaluate("window.__calls.length = 0")
    m.click("[data-delay='5']"); m.click("#c-edit")
    opts = [c for c in m.evaluate("window.__calls") if c["cmd"] == "set_options"]
    check("options pushed on delay and edit change", opts and opts[-1]["args"]["options"] == {"edit_before_save": True, "delay_secs": 5, "keep_overlays": True}, str(opts))
    m.click("#btn-window"); m.click("#btn-upload")
    modes = [c["args"]["mode"] for c in m.evaluate("window.__calls") if c["cmd"] == "start_capture"]
    check("capture buttons start window and upload modes", modes == ["window", "upload"], str(modes))
    m.evaluate("document.querySelector('.tab[data-view=settings]').click()")
    m.evaluate("window.__mock = async (cmd, a, o) => cmd === 'pick_folder' ? 'D:\\\\Shots' : null")
    m.click("#browse-dir"); m.wait_for_timeout(150)
    check("folder picker fills save folder", m.evaluate("document.getElementById('s-saveDir').value") == "D:\\Shots" and m.evaluate("window.__snipzi.getSettings().saveDir") == "D:\\Shots")
    m.click("[data-token='{date}'][data-target='s-filenameTemplate']")
    check("token chip appends to file name box", m.evaluate("document.getElementById('s-filenameTemplate').value") == "{date}")
    check("example name updates", re.search(r"\d{4}-\d\d-\d\d", m.evaluate("document.getElementById('example-name').textContent")) is not None)
    m.evaluate("window.__calls.length = 0")
    m.click("[data-reset-hotkeys]"); m.wait_for_timeout(150)
    hk = [c for c in m.evaluate("window.__calls") if c["cmd"] == "set_hotkeys"]
    check("reset shortcuts re-registers defaults", hk and hk[-1]["args"]["keys"] == {"region": "Ctrl+Shift+1", "screen": "Ctrl+Shift+2", "window": "Ctrl+Shift+3", "upload": "Ctrl+Shift+4"}, str(hk))
    m.click("[data-theme-pick=green]")
    check("theme: click applies green at once and persists", m.evaluate("document.documentElement.dataset.theme") == "green" and m.evaluate("window.__snipzi.getSettings().theme") == "green")
    bg = m.evaluate("getComputedStyle(document.body).backgroundColor")
    m.click("[data-theme-pick=dark]")
    check("theme: dark changes colours", m.evaluate("getComputedStyle(document.body).backgroundColor") != bg and m.evaluate("getComputedStyle(document.body).backgroundColor") == "rgb(18, 18, 20)")
    m.reload(); m.wait_for_function("window.__snipzi !== undefined")
    check("theme: remembered after reload", m.evaluate("document.documentElement.dataset.theme") == "dark")
    check("main page (new handlers): no JS errors", not merr, str(merr))
    m.close()

    # ---------------- annotation pixels ----------------
    an = ctx.new_page(); an.goto(BASE + "/index.html"); an.wait_for_function("window.__snipzi !== undefined")
    r = an.evaluate("""async () => {
      const w = 300, h = 200, d = new Uint8ClampedArray(w*h*4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y*w+x)*4; const on = (x + y) % 2; d[i] = on ? 255 : 0; d[i+1] = on ? 255 : 0; d[i+2] = on ? 255 : 0; d[i+3] = 255; }
      const url = await window.__snipzi.renderCrop({w, h, data: d}, {x: 0, y: 0, w, h}, [{t:'hide', x:10, y:10, w:40, h:40}, {t:'blur', x:100, y:10, w:60, h:60}, {t:'rect', x:200, y:100, w:50, h:50, c:'#e5383b', lw:4}]);
      const bmp = await createImageBitmap(await (await fetch(url)).blob());
      const c = new OffscreenCanvas(w, h), x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
      const px = (a, b) => Array.from(x.getImageData(a, b, 1, 1).data);
      const var_ = (X, Y, W, H) => { const q = x.getImageData(X, Y, W, H).data; let mn = 255, mx = 0; for (let i = 0; i < q.length; i += 4) { mn = Math.min(mn, q[i]); mx = Math.max(mx, q[i]); } return mx - mn; };
      return {hide: px(30, 30), blurRange: var_(100, 10, 60, 60), plainRange: var_(0, 100, 60, 60), rectEdge: px(200, 125), outside: px(300 - 1, 199)};
    }""")
    check("annotate: hide is solid black", r["hide"] == [0, 0, 0, 255], str(r["hide"]))
    check("annotate: blur removes fine detail (checkerboard flattened)", r["blurRange"] < r["plainRange"] / 2, str(r))
    check("annotate: box outline is red", r["rectEdge"][0] > 200 and r["rectEdge"][1] < 100, str(r["rectEdge"]))
    an.close()
    b.close()

print("\n%d failure(s)" % len(fails))
sys.exit(1 if fails else 0)
