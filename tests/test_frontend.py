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
    pg.evaluate("window.__snipzi.handleRegion({idx:0,x:10,y:20,w:100,h:50,redactions:[[0,0,20,20]]})")
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
    pg.evaluate("window.__snipzi.handleScreen(0)")
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
    pg.evaluate("window.__snipzi.handleRegion({idx:0,x:0,y:0,w:200,h:100,redactions:[]})")
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
    pg.evaluate("window.__snipzi.handleScreen(0)")
    check("history off: no new entry", pg.evaluate("JSON.parse(localStorage.getItem('snipziHistory')).length") == n_before)
    check("history off: last record still updated", pg.evaluate("JSON.parse(localStorage.getItem('snipziLast')).dimensions.width") == 400)

    # 5. not saving to file: record has no path
    pg.evaluate("window.__snipzi.setSettings({saveToFile:false, historyEnabled:true})")
    saved_n = len(pg.evaluate("window.__saved")); pg.evaluate("window.__snipzi.handleScreen(0)")
    check("save off: nothing written", len(pg.evaluate("window.__saved")) == saved_n)
    check("save off: Open button disabled", pg.evaluate("document.getElementById('last-open').disabled") is True)

    # 6. hotkey capture box
    pg.evaluate("window.__calls.length = 0")
    pg.click("#hk-region") if False else None
    pg.evaluate("document.querySelector('.tab[data-view=settings]').click()")
    pg.evaluate("""document.getElementById('hk-region').dispatchEvent(new KeyboardEvent('keydown', {code:'KeyS', key:'s', ctrlKey:true, shiftKey:true, bubbles:true, cancelable:true}))""")
    pg.wait_for_timeout(200)
    hk = [c for c in pg.evaluate("window.__calls") if c["cmd"] == "set_hotkeys"]
    check("hotkey: Ctrl+Shift+S registered", hk and hk[-1]["args"]["region"] == "Ctrl+Shift+S", str(hk))
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
    ib.evaluate("window.__snipzi.handleScreen(0)")
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
    def run_overlay(redact):
        ov = ctx.new_page()
        oerr = []; ov.on("pageerror", lambda e: oerr.append(str(e)))
        ov.add_init_script(f"localStorage.setItem('snipziSettings', JSON.stringify({{redactionEnabled: {str(redact).lower()}}}));")
        ov.goto(BASE + "/overlay.html?i=0")
        ov.evaluate("window.__FRAME = {w: 1600, h: 1200}")
        ov.evaluate("window.__listeners['overlay:frame'].forEach(cb => cb({payload: {idx: 0, redact: %s}}))" % str(redact).lower())
        ov.wait_for_function("window.__calls.some(c => c.cmd === 'overlay_ready')")
        return ov, oerr

    ov, oerr = run_overlay(False)
    check("overlay: plain hint when redaction is off", "hide" not in ov.evaluate("document.getElementById('hint').textContent"))
    check("overlay: painted frame at physical size", ov.evaluate("[document.getElementById('frame').width, document.getElementById('frame').height]") == [1600, 1200])
    ov.mouse.move(100, 100); ov.mouse.down(); ov.mouse.move(300, 250, steps=4); ov.mouse.up()
    ov.wait_for_function("window.__calls.some(c => c.cmd === 'finish_region')")
    res = [c for c in ov.evaluate("window.__calls") if c["cmd"] == "finish_region"][0]["args"]["result"]
    check("overlay: CSS to physical scaling (x2)", (res["x"], res["y"], res["w"], res["h"]) == (200, 200, 400, 300), str(res))
    check("overlay: no redactions when off", res["redactions"] == [])
    # tiny click does not finish; Esc cancels
    ov.evaluate("window.__calls.length = 0")
    ov.evaluate("window.__listeners['overlay:frame'].forEach(cb => cb({payload: {idx: 0, redact: %s}}))" % ('true' if False else 'false')); ov.wait_for_function("window.__calls.some(c => c.cmd === 'overlay_ready')")
    ov.mouse.click(50, 50)
    check("overlay: stray click does not finish", not any(c["cmd"] == "finish_region" for c in ov.evaluate("window.__calls")))
    ov.keyboard.press("Escape"); ov.wait_for_function("window.__calls.some(c => c.cmd === 'cancel_capture')")
    check("overlay: Escape cancels", True)
    ov.evaluate("window.__calls.length = 0")
    ov.evaluate("window.__listeners['overlay:frame'].forEach(cb => cb({payload: 0}))"); ov.wait_for_function("window.__calls.some(c => c.cmd === 'overlay_ready')")
    ov.mouse.click(60, 60, button="right"); ov.wait_for_function("window.__calls.some(c => c.cmd === 'cancel_capture')")
    check("overlay: right-click cancels", True)
    check("overlay: no JS errors", not oerr, str(oerr))
    ov.close()

    ov, oerr = run_overlay(True)
    check("overlay redact: hint says areas can be hidden", "hide" in ov.evaluate("document.getElementById('hint').textContent"))
    ov.mouse.move(100, 100); ov.mouse.down(); ov.mouse.move(400, 300, steps=4); ov.mouse.up()
    check("overlay redact: waits for confirmation", not any(c["cmd"] == "finish_region" for c in ov.evaluate("window.__calls")))
    ov.mouse.move(150, 120); ov.mouse.down(); ov.mouse.move(250, 180, steps=4); ov.mouse.up()
    ov.mouse.move(600, 500); ov.mouse.down(); ov.mouse.move(700, 550, steps=3); ov.mouse.up()  # outside selection: ignored
    check("overlay redact: one box drawn, outside drag ignored", ov.evaluate("document.querySelectorAll('.rbox').length") == 1)
    ov.keyboard.press("Enter"); ov.wait_for_function("window.__calls.some(c => c.cmd === 'finish_region')")
    res = [c for c in ov.evaluate("window.__calls") if c["cmd"] == "finish_region"][0]["args"]["result"]
    check("overlay redact: selection scaled", (res["x"], res["y"], res["w"], res["h"]) == (200, 200, 600, 400), str(res))
    check("overlay redact: box relative to selection and scaled", res["redactions"] == [[100, 40, 200, 120]], str(res["redactions"]))
    # click on a box removes it
    ov.evaluate("window.__calls.length = 0")
    ov.evaluate("window.__listeners['overlay:frame'].forEach(cb => cb({payload: 0}))"); ov.wait_for_function("window.__calls.some(c => c.cmd === 'overlay_ready')")
    ov.mouse.move(100, 100); ov.mouse.down(); ov.mouse.move(400, 300, steps=3); ov.mouse.up()
    ov.mouse.move(150, 120); ov.mouse.down(); ov.mouse.move(250, 180, steps=3); ov.mouse.up()
    ov.mouse.click(200, 150)
    check("overlay redact: clicking a box removes it", ov.evaluate("document.querySelectorAll('.rbox').length") == 0)
    check("overlay redact: no JS errors", not oerr, str(oerr))
    ov.close()
    b.close()

print("\n%d failure(s)" % len(fails))
sys.exit(1 if fails else 0)
