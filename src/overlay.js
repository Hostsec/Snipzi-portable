// overlay.js runs in two kinds of window:
//  1. a full-screen window per monitor (region / window / scrolling capture, colour picker, ruler),
//     which paints the frozen screen grab and lets the user act on it;
//  2. the editor window (overlay.html?editor=1), which shows a saved capture so it can be
//     annotated later, with zoom.
// Everything is measured in "frame pixels" (real pixels of the picture). CSS pixels are converted
// with sx/sy, which are recomputed from the stage size whenever they are needed.
(function () {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const $ = (id) => document.getElementById(id);

  const editorMode = document.documentElement.classList.contains("editor");
  const idx = Number(new URLSearchParams(location.search).get("i") || 0);
  const stage = $("stage"), wrap = $("wrap");
  const base = $("frame"), ann = $("ann");
  const bctx = base.getContext("2d", { willReadFrequently: true }), actx = ann.getContext("2d");
  const dim = $("dim"), sel = $("sel"), tag = $("tag"), bar = $("bar"), hint = $("hint"), winhl = $("winhl");
  const mbox = $("mbox"), mlabel = $("mlabel"), loupe = $("loupe"), lcv = $("lcv"), lctx = lcv.getContext("2d"), lval = $("lval");

  const COLORS = ["#e5383b", "#ff8c00", "#ffd60a", "#2ecc71", "#2f80ed", "#111111", "#ffffff"];
  const TOOL_HINTS = {
    select: "Drag the corners or edges to resize or crop, drag inside to move. Arrow keys nudge (Shift = faster).",
    arrow: "Drag to draw an arrow.",
    rect: "Drag to draw a box.",
    ellipse: "Drag to draw a circle or oval.",
    pen: "Drag to draw freehand.",
    hl: "Drag over text or an area to highlight it.",
    text: "Click where the text should go, type, then press Enter.",
    step: "Click to place numbered markers.",
    blur: "Drag over anything private to pixelate it so it cannot be read.",
    hide: "Drag over anything private to cover it with a solid black box."
  };

  let frame = null;            // { w, h } real pixels of the picture
  let mode = "region";         // region | window | scroll | picker | ruler
  let editDefault = false;     // user setting: open the editor after selecting
  let uploadHotkey = false;    // this capture will be uploaded anyway
  let windows = [];            // window rectangles in monitor pixels, topmost first
  let phase = "idle";          // idle | drag | edit | mdrag | measure
  let sx = 1, sy = 1, stageLeft = 0, stageTop = 0;
  let selF = null;             // selection in frame px
  let start = null, last = null, spaceDown = false;
  let shapes = [], cur = null;
  let tool = "select", color = COLORS[0], sizeIdx = 1;
  let drag = null;             // active editor drag
  let hoverWin = null;
  let textInput = null;
  let pick = null;             // colour picker: pixel under the pointer
  let mA = null, mB = null;    // ruler end points
  let editorKey = null, view = 1;

  // ----- geometry helpers -----
  function refresh() {
    if (!frame) return;
    const r = stage.getBoundingClientRect();
    sx = frame.w / Math.max(1, r.width);
    sy = frame.h / Math.max(1, r.height);
    stageLeft = r.left; stageTop = r.top;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fpt(e) {
    refresh();
    return { x: clamp((e.clientX - stageLeft) * sx, 0, frame.w), y: clamp((e.clientY - stageTop) * sy, 0, frame.h) };
  }
  function normRect(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }; }
  function inSel(p) { return selF && p.x >= selF.x && p.x <= selF.x + selF.w && p.y >= selF.y && p.y <= selF.y + selF.h; }
  function place(el, r) {
    el.style.left = r.x / sx + "px"; el.style.top = r.y / sy + "px";
    el.style.width = r.w / sx + "px"; el.style.height = r.h / sy + "px";
  }
  function setHint(text) { hint.textContent = text; hint.style.display = text ? "block" : "none"; }

  function idleHint() {
    const up = uploadHotkey ? " It will be uploaded to ImgBay." : "";
    if (mode === "window") return "Click a window to capture it. Esc cancels." + up;
    if (mode === "picker") return "Move over a colour and click to copy it. Arrow keys move one pixel. Esc cancels.";
    if (mode === "ruler") return "Drag to measure in pixels. Press C or click the label to copy the size. Esc closes.";
    if (mode === "scroll") return "Drag over the part that scrolls (the page or list itself, without side bars). Snipzi then scrolls it for you, so keep the mouse still. Start from the top. Press Esc while it scrolls to stop.";
    const parts = ["Drag to select an area."];
    parts.push(editDefault ? "You can edit it before saving." : "Press Space for the whole screen. Hold Shift when you let go to edit first.");
    parts.push("Esc cancels." + up);
    return parts.join(" ");
  }

  function resetUi() {
    phase = "idle"; selF = null; start = null; drag = null; cur = null; shapes = []; hoverWin = null; spaceDown = false;
    pick = null; mA = mB = null;
    removeTextInput();
    sel.style.display = "none"; sel.classList.remove("editing", "selecting");
    tag.style.display = "none"; bar.style.display = "none"; winhl.style.display = "none";
    mbox.style.display = "none"; mlabel.style.display = "none"; loupe.style.display = "none";
    dim.style.display = mode === "region" || mode === "scroll" ? "block" : "none";
    actx.clearRect(0, 0, ann.width, ann.height);
    setHint(idleHint());
  }

  function redraw() {
    actx.clearRect(0, 0, ann.width, ann.height);
    window.SnipziAnnotate.drawShapes(actx, cur ? shapes.concat([cur]) : shapes, base);
  }

  function updateTag(r, label) {
    tag.textContent = label || (Math.round(r.w) + " x " + Math.round(r.h));
    tag.style.display = "block";
    tag.style.left = r.x / sx + "px";
    tag.style.top = Math.max(0, r.y / sy - 24) + "px";
  }

  function loadFrameFrom(w, h) {
    base.width = ann.width = w; base.height = ann.height = h;
    frame = { w, h };
  }

  // ----- full-screen overlay: events from Rust -----
  if (!editorMode) {
    listen("overlay:frame", async (e) => {
      const p = (e && e.payload) || {};
      mode = p.mode || "region";
      editDefault = !!p.edit && (mode === "region" || mode === "window");
      uploadHotkey = !!p.upload;
      windows = Array.isArray(p.windows) ? p.windows : [];
      try {
        const buf = await invoke("get_frame", { idx });
        const dv = new DataView(buf);
        const w = dv.getUint32(0, true), h = dv.getUint32(4, true);
        loadFrameFrom(w, h);
        bctx.putImageData(new ImageData(new Uint8ClampedArray(buf, 8, w * h * 4), w, h), 0, 0);
        refresh();
      } catch (err) {
        await invoke("cancel_capture");
        return;
      }
      resetUi();
      await invoke("overlay_ready");
      window.focus();
    }).then(() => invoke("overlay_loaded", { idx }));
  }

  // ----- selection + toolbar -----
  function renderSel() {
    refresh();
    place(sel, selF);
    sel.style.display = "block";
    updateTag(selF);
    if (phase === "edit") positionBar();
  }

  function updateWrapTop() {
    if (editorMode) document.documentElement.style.setProperty("--barh", bar.offsetHeight + "px");
  }

  function positionBar() {
    bar.style.display = "block";
    if (editorMode) { updateWrapTop(); return; }
    const bw = bar.offsetWidth || 560, bh = bar.offsetHeight || 110;
    const W = stage.clientWidth, H = stage.clientHeight;
    const r = { x: selF.x / sx, y: selF.y / sy, w: selF.w / sx, h: selF.h / sy };
    const left = clamp(r.x, 4, Math.max(4, W - bw - 4));
    let top = r.y + r.h + 10;
    if (top + bh > H - 4) top = r.y - bh - 10;
    if (top < 4) top = clamp(r.y + r.h - bh - 10, 4, H - bh - 4);
    bar.style.left = left + "px"; bar.style.top = top + "px";
  }

  function syncBar() {
    document.querySelectorAll("#tools button").forEach((b) => b.classList.toggle("on", b.dataset.tool === tool));
    document.querySelectorAll("[data-size]").forEach((b) => b.classList.toggle("on", Number(b.dataset.size) === sizeIdx));
    document.querySelectorAll("#colors .sw").forEach((b) => b.classList.toggle("on", b.dataset.color === color));
    $("toolhint").textContent = TOOL_HINTS[tool];
    sel.classList.toggle("selecting", tool === "select");
    updateWrapTop();
  }

  function enterEdit(rect) {
    selF = rect;
    phase = "edit";
    tool = editorMode ? "arrow" : "select";
    dim.style.display = "none"; winhl.style.display = "none";
    setHint("");
    sel.classList.add("editing");
    syncBar();
    renderSel();
  }

  function setTool(t) { removeTextInput(true); tool = t; syncBar(); }

  COLORS.forEach((c) => {
    const b = document.createElement("button");
    b.className = "sw"; b.dataset.color = c; b.style.background = c; b.title = "Color";
    b.addEventListener("click", () => { color = c; syncBar(); });
    $("colors").appendChild(b);
  });
  document.querySelectorAll("#tools button").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  document.querySelectorAll("[data-size]").forEach((b) => b.addEventListener("click", () => { sizeIdx = Number(b.dataset.size); syncBar(); }));
  $("undo").addEventListener("click", undo);
  $("cancel").addEventListener("click", () => cancel());
  $("save").addEventListener("click", () => finish(false));
  $("saveup").addEventListener("click", () => finish(true));
  ["mousedown", "mouseup", "mousemove", "contextmenu"].forEach((n) => bar.addEventListener(n, (e) => e.stopPropagation()));
  ["mousedown", "mouseup", "mousemove"].forEach((n) => mlabel.addEventListener(n, (e) => e.stopPropagation()));

  function undo() { if (shapes.length) { shapes.pop(); redraw(); } }

  async function cancel() {
    if (editorMode) { await invoke("close_editor"); return; }
    resetUi();
    await invoke("cancel_capture");
  }

  async function finish(upload) {
    if (!selF || !frame) return;
    commitText();
    const r = {
      x: clamp(Math.round(selF.x), 0, frame.w - 1), y: clamp(Math.round(selF.y), 0, frame.h - 1),
      w: 1, h: 1
    };
    r.w = clamp(Math.round(selF.w), 1, frame.w - r.x);
    r.h = clamp(Math.round(selF.h), 1, frame.h - r.y);
    const out = shapes.map((s) => JSON.parse(JSON.stringify(s)));
    if (editorMode) {
      await invoke("editor_done", { result: { key: editorKey, x: r.x, y: r.y, w: r.w, h: r.h, shapes: out, upload: !!upload } });
      return;
    }
    resetUi();
    await invoke("finish_region", { result: { idx, x: r.x, y: r.y, w: r.w, h: r.h, shapes: out, upload: !!upload } });
  }

  // ----- text tool -----
  function sizes() {
    refresh();
    const u = sx;
    return { lw: [3, 5, 9][sizeIdx] * u, text: [18, 26, 38][sizeIdx] * u, step: [12, 16, 22][sizeIdx] * u };
  }
  function removeTextInput(commit) {
    if (!textInput) return;
    if (commit) commitText(); else { textInput.remove(); textInput = null; }
  }
  function commitText() {
    if (!textInput) return;
    const el = textInput; textInput = null;
    const text = el.value;
    refresh();
    const rect = el.getBoundingClientRect();
    const size = parseFloat(el.dataset.size);
    el.remove();
    if (text.trim()) {
      shapes.push({ t: "text", x: (rect.left - stageLeft + 3) * sx, y: (rect.top - stageTop + 2) * sy, text, c: el.dataset.color, size });
      redraw();
    }
  }
  function startText(e) {
    removeTextInput(true);
    const s = sizes();
    const el = document.createElement("input");
    el.className = "txt"; el.type = "text";
    el.style.left = e.clientX - stageLeft + "px"; el.style.top = e.clientY - stageTop + "px";
    el.style.fontSize = s.text / sy + "px"; el.style.color = color;
    el.dataset.size = String(s.text); el.dataset.color = color;
    stage.appendChild(el);
    textInput = el;
    setTimeout(() => el.focus(), 0);
    el.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") { commitText(); }
      else if (ev.key === "Escape") { el.remove(); textInput = null; }
    });
    el.addEventListener("mousedown", (ev) => ev.stopPropagation());
  }

  // ----- colour picker -----
  const hex2 = (n) => n.toString(16).padStart(2, "0");
  function updatePick(px, py) {
    pick = { x: clamp(Math.floor(px), 0, frame.w - 1), y: clamp(Math.floor(py), 0, frame.h - 1) };
    const d = bctx.getImageData(pick.x, pick.y, 1, 1).data;
    pick.rgb = [d[0], d[1], d[2]];
    lctx.imageSmoothingEnabled = false;
    lctx.fillStyle = "#000"; lctx.fillRect(0, 0, 132, 132);
    lctx.drawImage(base, pick.x - 5, pick.y - 5, 11, 11, 0, 0, 132, 132);
    lctx.lineWidth = 2; lctx.strokeStyle = "#fff"; lctx.strokeRect(61, 61, 12, 12);
    lctx.lineWidth = 1; lctx.strokeStyle = "#000"; lctx.strokeRect(59.5, 59.5, 15, 15);
    const hex = "#" + pick.rgb.map(hex2).join("").toUpperCase();
    lval.innerHTML = "";
    const sw = document.createElement("span"); sw.id = "lsw"; sw.style.background = hex;
    lval.appendChild(sw);
    lval.appendChild(document.createTextNode(hex + "\nrgb(" + pick.rgb.join(", ") + ")\n" + pick.x + ", " + pick.y));
    lval.style.whiteSpace = "pre";
    refresh();
    const cx = pick.x / sx, cy = pick.y / sy;
    const W = stage.clientWidth, H = stage.clientHeight;
    let left = cx + 22, top = cy + 22;
    if (left + 150 > W) left = cx - 22 - 148;
    if (top + 190 > H) top = cy - 22 - 188;
    loupe.style.left = Math.max(2, left) + "px"; loupe.style.top = Math.max(2, top) + "px";
    loupe.style.display = "block";
    setHint("");
  }

  async function pickNow() {
    if (!pick) return;
    const [r, g, b] = pick.rgb;
    const { x, y } = pick;
    resetUi();
    await invoke("finish_pick", { result: { r, g, b, x, y } });
  }

  // ----- ruler -----
  function measureText() {
    const w = Math.round(Math.abs(mB.x - mA.x)), h = Math.round(Math.abs(mB.y - mA.y));
    const diag = Math.round(Math.hypot(w, h));
    return { w, h, diag };
  }
  function drawMeasure(copied) {
    const r = normRect(mA, mB);
    place(mbox, r); mbox.style.display = "block";
    const m = measureText();
    const dpr = window.devicePixelRatio || 1;
    let text = m.w + " × " + m.h + " px\ndiagonal " + m.diag + " px";
    if (dpr > 1.01) text += "\n" + Math.round(m.w / dpr) + " × " + Math.round(m.h / dpr) + " at " + Math.round(dpr * 100) + "% scaling";
    text += copied ? "\nCopied" : "\nClick or press C to copy";
    mlabel.textContent = text;
    mlabel.style.display = "block";
    const W = stage.clientWidth, H = stage.clientHeight;
    const bw = mlabel.offsetWidth || 150, bh = mlabel.offsetHeight || 70;
    let left = clamp(r.x / sx, 4, Math.max(4, W - bw - 4));
    let top = (r.y + r.h) / sy + 8;
    if (top + bh > H - 4) top = r.y / sy - bh - 8;
    if (top < 4) top = clamp((r.y + r.h) / sy - bh - 8, 4, Math.max(4, H - bh - 4));
    mlabel.style.left = left + "px"; mlabel.style.top = top + "px";
  }
  async function copyMeasure() {
    if (!mA || !mB) return;
    const m = measureText();
    try { await invoke("copy_text", { text: m.w + " x " + m.h }); drawMeasure(true); } catch (e) { /* ignore */ }
  }
  mlabel.addEventListener("click", copyMeasure);

  // ----- editor window: zoom + loading -----
  function setView(v, keepCenter) {
    if (!frame) return;
    v = clamp(v, 0.05, 8);
    const oldW = stage.clientWidth || 1, oldH = stage.clientHeight || 1;
    const fx = (wrap.scrollLeft + wrap.clientWidth / 2) / oldW, fy = (wrap.scrollTop + wrap.clientHeight / 2) / oldH;
    view = v;
    stage.style.width = Math.round(frame.w * v) + "px";
    stage.style.height = Math.round(frame.h * v) + "px";
    $("zlabel").textContent = Math.round(v * 100) + "%";
    refresh();
    if (keepCenter) {
      wrap.scrollLeft = fx * stage.clientWidth - wrap.clientWidth / 2;
      wrap.scrollTop = fy * stage.clientHeight - wrap.clientHeight / 2;
    }
    removeTextInput(true);
    if (selF) renderSel();
  }
  function fitView() {
    if (!frame) return;
    const cw = Math.max(100, wrap.clientWidth - 28), ch = Math.max(100, wrap.clientHeight - 28);
    const fit = Math.min(cw / frame.w, ch / frame.h);
    // very tall pictures (scrolling captures) are shown at window width and scrolled
    const v = fit < 0.4 ? Math.min(cw / frame.w, 1) : Math.min(fit, 1);
    setView(v, false);
    wrap.scrollLeft = 0; wrap.scrollTop = 0;
  }

  let pipelineLoaded = null;
  function ensurePipeline() {
    if (!pipelineLoaded) {
      pipelineLoaded = new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "pipeline.js"; s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    return pipelineLoaded;
  }

  async function loadEditorImage() {
    try {
      await ensurePipeline();
      editorKey = localStorage.getItem("snipziEditKey");
      const rec = editorKey ? await fpsIdbGet(editorKey) : null;
      if (!rec || !rec.blob) throw new Error("This picture is no longer available.");
      const bmp = await createImageBitmap(rec.blob);
      loadFrameFrom(bmp.width, bmp.height);
      bctx.drawImage(bmp, 0, 0);
      if (rec.title) document.title = "Snipzi editor - " + rec.title;
      mode = "region"; shapes = []; cur = null; sizeIdx = 1;
      fitView();
      enterEdit({ x: 0, y: 0, w: frame.w, h: frame.h });
      $("cancel").textContent = "Close";
      $("save").textContent = "Save a copy";
      $("save").title = "Save as a new file. The original stays as it is (Enter)";
      $("saveup").textContent = "Save a copy and upload";
      fitView();
    } catch (e) {
      $("toolhint").textContent = (e && e.message) || String(e);
    }
  }

  if (editorMode) {
    document.title = "Snipzi editor";
    listen("editor:load", loadEditorImage);
    loadEditorImage();
    window.addEventListener("resize", () => { updateWrapTop(); refresh(); if (selF) renderSel(); });
    wrap.addEventListener("wheel", (e) => {
      if (e.ctrlKey) { e.preventDefault(); setView(view * (e.deltaY < 0 ? 1.15 : 1 / 1.15), true); }
      else removeTextInput(true);
    }, { passive: false });
    $("zin").addEventListener("click", () => setView(view * 1.25, true));
    $("zout").addEventListener("click", () => setView(view / 1.25, true));
    $("zfit").addEventListener("click", fitView);
    $("z100").addEventListener("click", () => setView(1, true));
  } else {
    window.addEventListener("resize", () => { refresh(); if (selF && phase !== "idle") renderSel(); });
  }

  // ----- mouse -----
  function pickWindow(p) {
    for (const w of windows) {
      if (p.x >= w.x && p.x < w.x + w.w && p.y >= w.y && p.y < w.y + w.h) return w;
    }
    return null;
  }

  function startDraw(p, e) {
    const s = sizes();
    if (tool === "text") { startText(e); return; }
    if (tool === "step") {
      shapes.push({ t: "step", x: p.x, y: p.y, n: shapes.filter((q) => q.t === "step").length + 1, c: color, r: s.step });
      redraw();
      return;
    }
    drag = { type: "draw", from: p };
    if (tool === "arrow") cur = { t: "arrow", x1: p.x, y1: p.y, x2: p.x, y2: p.y, c: color, w: s.lw };
    else if (tool === "pen") cur = { t: "pen", pts: [[p.x, p.y]], c: color, lw: s.lw };
    else if (tool === "hl") cur = { t: "hl", pts: [[p.x, p.y]], c: color, lw: s.lw * 5 };
    else if (tool === "rect" || tool === "ellipse") cur = { t: tool, x: p.x, y: p.y, w: 0, h: 0, c: color, lw: s.lw };
    else if (tool === "blur" || tool === "hide") cur = { t: tool, x: p.x, y: p.y, w: 0, h: 0 };
    redraw();
  }

  window.addEventListener("mousedown", (e) => {
    if (!frame) return;
    if (e.button === 2) { if (phase !== "edit" && !editorMode) cancel(); return; }
    if (e.button !== 0) return;
    if (!e.target.closest || !e.target.closest("#stage")) return;
    const p = fpt(e);

    if (phase === "idle" || phase === "measure") {
      if (mode === "window") {
        const w = hoverWin || { x: 0, y: 0, w: frame.w, h: frame.h };
        const rect = { x: w.x, y: w.y, w: w.w, h: w.h };
        if (editDefault || e.shiftKey) enterEdit(rect);
        else { selF = rect; finish(false); }
        return;
      }
      if (mode === "picker") { updatePick(p.x, p.y); pickNow(); return; }
      if (mode === "ruler") {
        phase = "mdrag"; mA = p; mB = p; setHint("");
        mbox.style.display = "none"; mlabel.style.display = "none"; tag.style.display = "none";
        return;
      }
      phase = "drag";
      start = p; last = { x: e.clientX, y: e.clientY };
      setHint(""); dim.style.display = "none";
      selF = { x: p.x, y: p.y, w: 0, h: 0 };
      renderSel();
      return;
    }

    if (phase === "edit") {
      const handle = e.target && e.target.dataset && e.target.dataset.h;
      if (tool === "select") {
        if (handle) { drag = { type: "resize", handle, from: p, orig: { ...selF } }; return; }
        if (inSel(p)) { drag = { type: "move", from: p, orig: { ...selF } }; return; }
        if (editorMode) return;
        // outside the selection: start a fresh one
        removeTextInput(true);
        phase = "drag"; start = p; last = { x: e.clientX, y: e.clientY };
        shapes = []; redraw(); bar.style.display = "none"; sel.classList.remove("editing", "selecting");
        selF = { x: p.x, y: p.y, w: 0, h: 0 }; renderSel();
        return;
      }
      if (inSel(p)) startDraw(p, e);
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (!frame) return;
    const p = fpt(e);

    if (phase === "idle" && mode === "window") {
      hoverWin = pickWindow(p);
      const w = hoverWin || { x: 0, y: 0, w: frame.w, h: frame.h, title: "Whole screen" };
      place(winhl, w); winhl.style.display = "block";
      updateTag(w, w.title || "Window");
      return;
    }
    if (mode === "picker" && phase === "idle") { updatePick(p.x, p.y); return; }
    if (mode === "ruler") {
      if (phase === "mdrag") { mB = p; drawMeasure(false); return; }
      if (phase === "idle" || phase === "measure") {
        tag.textContent = Math.round(p.x) + ", " + Math.round(p.y);
        tag.style.display = "block";
        tag.style.left = p.x / sx + 14 + "px"; tag.style.top = p.y / sy + 14 + "px";
      }
      return;
    }

    if (phase === "drag") {
      if (spaceDown && last) {
        // Space held: move the whole selection instead of resizing it
        start = { x: start.x + (e.clientX - last.x) * sx, y: start.y + (e.clientY - last.y) * sy };
      }
      last = { x: e.clientX, y: e.clientY };
      selF = normRect(start, p);
      renderSel();
      return;
    }

    if (phase === "edit" && drag) {
      if (drag.type === "move") {
        selF.x = clamp(drag.orig.x + p.x - drag.from.x, 0, frame.w - selF.w);
        selF.y = clamp(drag.orig.y + p.y - drag.from.y, 0, frame.h - selF.h);
        renderSel();
      } else if (drag.type === "resize") {
        const o = drag.orig, h = drag.handle;
        let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
        if (h.includes("w")) x1 = clamp(p.x, 0, x2 - 8);
        if (h.includes("e")) x2 = clamp(p.x, x1 + 8, frame.w);
        if (h.includes("n")) y1 = clamp(p.y, 0, y2 - 8);
        if (h.includes("s")) y2 = clamp(p.y, y1 + 8, frame.h);
        selF = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        renderSel();
      } else if (drag.type === "draw" && cur) {
        const q = { x: clamp(p.x, selF.x, selF.x + selF.w), y: clamp(p.y, selF.y, selF.y + selF.h) };
        if (cur.t === "arrow") { cur.x2 = q.x; cur.y2 = q.y; }
        else if (cur.pts) cur.pts.push([Math.round(q.x), Math.round(q.y)]);
        else { const r = normRect(drag.from, q); cur.x = r.x; cur.y = r.y; cur.w = r.w; cur.h = r.h; }
        redraw();
      }
    }
  });

  window.addEventListener("mouseup", (e) => {
    if (e.button !== 0 || !frame) return;
    if (phase === "mdrag") {
      const m = measureText();
      if (m.w < 2 && m.h < 2) { phase = "idle"; mA = mB = null; mbox.style.display = "none"; mlabel.style.display = "none"; setHint(idleHint()); return; }
      phase = "measure"; drawMeasure(false);
      return;
    }
    if (phase === "drag") {
      const tooSmall = selF.w / sx < 5 || selF.h / sy < 5;
      if (tooSmall) { resetUi(); return; }   // a stray click: start over, do not cancel the capture
      if (mode === "scroll") finish(false);
      else if (editDefault || e.shiftKey) enterEdit(selF);
      else finish(false);
      return;
    }
    if (phase === "edit" && drag) {
      if (drag.type === "draw" && cur) {
        const tiny = cur.t === "arrow" ? Math.hypot(cur.x2 - cur.x1, cur.y2 - cur.y1) < 4 : (cur.w !== undefined && (cur.w < 3 || cur.h < 3));
        if (!tiny) shapes.push(cur);
        cur = null; redraw();
      }
      drag = null;
    }
  });

  window.addEventListener("contextmenu", (e) => e.preventDefault());

  window.addEventListener("keydown", (e) => {
    if (!frame) return;
    if ((e.ctrlKey || e.metaKey) && editorMode) {
      if (e.key === "0") { e.preventDefault(); fitView(); return; }
      if (e.key === "+" || e.key === "=") { e.preventDefault(); setView(view * 1.25, true); return; }
      if (e.key === "-") { e.preventDefault(); setView(view / 1.25, true); return; }
    }
    if (e.key === "Escape") {
      if (editorMode && shapes.length) { $("toolhint").textContent = "You have drawings that are not saved. Press Cancel to discard them or Save a copy to keep them."; return; }
      cancel();
      return;
    }
    if (mode === "picker" && phase === "idle") {
      if (e.key.startsWith("Arrow") && pick) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const nx = pick.x + (e.key === "ArrowRight" ? d : e.key === "ArrowLeft" ? -d : 0);
        const ny = pick.y + (e.key === "ArrowDown" ? d : e.key === "ArrowUp" ? -d : 0);
        updatePick(nx, ny);
      } else if (e.key === "Enter" && pick) { pickNow(); }
      return;
    }
    if (mode === "ruler") {
      if ((e.key === "c" || e.key === "C" || e.key === "Enter") && mA && mB && phase === "measure") { e.preventDefault(); copyMeasure(); return; }
      if (e.key.startsWith("Arrow") && phase === "measure") {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        if (e.key === "ArrowRight") mB = { x: clamp(mB.x + d, 0, frame.w), y: mB.y };
        if (e.key === "ArrowLeft") mB = { x: clamp(mB.x - d, 0, frame.w), y: mB.y };
        if (e.key === "ArrowDown") mB = { x: mB.x, y: clamp(mB.y + d, 0, frame.h) };
        if (e.key === "ArrowUp") mB = { x: mB.x, y: clamp(mB.y - d, 0, frame.h) };
        drawMeasure(false);
      }
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      if (phase === "idle" && mode === "region") enterEdit({ x: 0, y: 0, w: frame.w, h: frame.h });
      else if (phase === "drag") spaceDown = true;
      return;
    }
    if (phase !== "edit") return;
    if (e.key === "Enter") { finish(false); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
    if (tool === "select" && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const d = (e.shiftKey ? 10 : 1);
      if (e.key === "ArrowLeft") selF.x = clamp(selF.x - d, 0, frame.w - selF.w);
      if (e.key === "ArrowRight") selF.x = clamp(selF.x + d, 0, frame.w - selF.w);
      if (e.key === "ArrowUp") selF.y = clamp(selF.y - d, 0, frame.h - selF.h);
      if (e.key === "ArrowDown") selF.y = clamp(selF.y + d, 0, frame.h - selF.h);
      renderSel();
    }
  });
  window.addEventListener("keyup", (e) => { if (e.key === " ") spaceDown = false; });
})();
