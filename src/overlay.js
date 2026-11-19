// overlay.js: runs in one full-screen window per monitor. The Rust side grabs the screen first,
// this window paints that frozen image, and the user either drags an area, clicks a window, or
// (editor) adjusts the area and draws on it. The result goes back to Rust.
(function () {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const $ = (id) => document.getElementById(id);

  const idx = Number(new URLSearchParams(location.search).get("i") || 0);
  const base = $("frame"), ann = $("ann");
  const bctx = base.getContext("2d"), actx = ann.getContext("2d");
  const dim = $("dim"), sel = $("sel"), tag = $("tag"), bar = $("bar"), hint = $("hint"), winhl = $("winhl");

  const COLORS = ["#e5383b", "#ff8c00", "#ffd60a", "#2ecc71", "#2f80ed", "#111111", "#ffffff"];
  const TOOL_HINTS = {
    select: "Drag the corners or edges to resize, drag inside to move. Arrow keys nudge (Shift = faster).",
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

  let frame = null;            // { w, h } physical pixels of this monitor
  let mode = "region";         // "region" | "window"
  let editDefault = false;     // user setting: open the editor after selecting
  let uploadHotkey = false;    // this capture will be uploaded anyway
  let windows = [];            // window rectangles in monitor pixels, topmost first
  let phase = "idle";          // "idle" | "drag" | "edit"
  let sx = 1, sy = 1;          // CSS px to monitor px
  let selF = null;             // selection in monitor px
  let start = null, last = null, spaceDown = false;
  let shapes = [], cur = null;
  let tool = "select", color = COLORS[0], sizeIdx = 1;
  let drag = null;             // active editor drag: {type:'move'|'resize'|'draw', ...}
  let hoverWin = null;
  let textInput = null;

  // ----- helpers -----
  function fpt(e) { return { x: e.clientX * sx, y: e.clientY * sy }; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function normRect(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }; }
  function inSel(p) { return selF && p.x >= selF.x && p.x <= selF.x + selF.w && p.y >= selF.y && p.y <= selF.y + selF.h; }
  function place(el, r) {
    el.style.left = r.x / sx + "px"; el.style.top = r.y / sy + "px";
    el.style.width = r.w / sx + "px"; el.style.height = r.h / sy + "px";
  }
  function setHint(text) { hint.textContent = text; hint.style.display = text ? "block" : "none"; }

  function idleHint() {
    if (mode === "window") return "Click a window to capture it. Esc cancels." + (uploadHotkey ? " It will be uploaded to ImgBay." : "");
    const parts = ["Drag to select an area."];
    parts.push(editDefault ? "You can edit it before saving." : "Press Space for the whole screen. Hold Shift when you let go to edit first.");
    parts.push("Esc cancels." + (uploadHotkey ? " It will be uploaded to ImgBay." : ""));
    return parts.join(" ");
  }

  function resetUi() {
    phase = "idle"; selF = null; start = null; drag = null; cur = null; shapes = []; hoverWin = null; spaceDown = false;
    removeTextInput();
    sel.style.display = "none"; sel.classList.remove("editing", "selecting");
    tag.style.display = "none"; bar.style.display = "none"; winhl.style.display = "none";
    dim.style.display = mode === "window" ? "none" : "block";
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

  // ----- events from Rust -----
  listen("overlay:frame", async (e) => {
    const p = (e && e.payload) || {};
    mode = p.mode || "region";
    editDefault = !!p.edit;
    uploadHotkey = !!p.upload;
    windows = Array.isArray(p.windows) ? p.windows : [];
    try {
      const buf = await invoke("get_frame", { idx });
      const dv = new DataView(buf);
      const w = dv.getUint32(0, true), h = dv.getUint32(4, true);
      base.width = ann.width = w; base.height = ann.height = h;
      bctx.putImageData(new ImageData(new Uint8ClampedArray(buf, 8, w * h * 4), w, h), 0, 0);
      frame = { w, h };
      sx = w / window.innerWidth; sy = h / window.innerHeight;
    } catch (err) {
      await invoke("cancel_capture");
      return;
    }
    resetUi();
    await invoke("overlay_ready");
    window.focus();
  }).then(() => invoke("overlay_loaded", { idx }));

  // ----- editor: selection, toolbar -----
  function renderSel() {
    place(sel, selF);
    sel.style.display = "block";
    updateTag(selF);
    if (phase === "edit") positionBar();
  }

  function positionBar() {
    bar.style.display = "block";
    const bw = bar.offsetWidth || 560, bh = bar.offsetHeight || 110;
    const r = { x: selF.x / sx, y: selF.y / sy, w: selF.w / sx, h: selF.h / sy };
    let left = clamp(r.x, 4, Math.max(4, window.innerWidth - bw - 4));
    let top = r.y + r.h + 10;
    if (top + bh > window.innerHeight - 4) top = r.y - bh - 10;
    if (top < 4) top = clamp(r.y + r.h - bh - 10, 4, window.innerHeight - bh - 4);
    bar.style.left = left + "px"; bar.style.top = top + "px";
  }

  function syncBar() {
    document.querySelectorAll("#tools button").forEach((b) => b.classList.toggle("on", b.dataset.tool === tool));
    document.querySelectorAll("[data-size]").forEach((b) => b.classList.toggle("on", Number(b.dataset.size) === sizeIdx));
    document.querySelectorAll("#colors .sw").forEach((b) => b.classList.toggle("on", b.dataset.color === color));
    $("toolhint").textContent = TOOL_HINTS[tool];
    sel.classList.toggle("selecting", tool === "select");
  }

  function enterEdit(rect) {
    selF = rect;
    phase = "edit";
    tool = "select";
    dim.style.display = "none"; winhl.style.display = "none";
    setHint("");
    sel.classList.add("editing");
    syncBar();
    renderSel();
  }

  function setTool(t) { removeTextInput(true); tool = t; syncBar(); }

  // build colour swatches once
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

  function undo() { if (shapes.length) { shapes.pop(); redraw(); } }

  async function cancel() {
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
    resetUi();
    await invoke("finish_region", { result: { idx, x: r.x, y: r.y, w: r.w, h: r.h, shapes: out, upload: !!upload } });
  }

  // ----- text tool -----
  function sizes() {
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
    const rect = el.getBoundingClientRect();
    const size = parseFloat(el.dataset.size);
    el.remove();
    if (text.trim()) {
      shapes.push({ t: "text", x: (rect.left + 3) * sx, y: (rect.top + 2) * sy, text, c: el.dataset.color, size });
      redraw();
    }
  }
  function startText(p, e) {
    removeTextInput(true);
    const s = sizes();
    const el = document.createElement("input");
    el.className = "txt"; el.type = "text";
    el.style.left = e.clientX + "px"; el.style.top = e.clientY + "px";
    el.style.fontSize = s.text / sy + "px"; el.style.color = color;
    el.dataset.size = String(s.text); el.dataset.color = color;
    document.body.appendChild(el);
    textInput = el;
    setTimeout(() => el.focus(), 0);
    el.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") { commitText(); }
      else if (ev.key === "Escape") { el.remove(); textInput = null; }
    });
    el.addEventListener("mousedown", (ev) => ev.stopPropagation());
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
    if (tool === "text") { startText(p, e); return; }
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
    if (e.button === 2) { if (phase !== "edit") cancel(); return; }
    if (e.button !== 0) return;
    const p = fpt(e);

    if (phase === "idle") {
      if (mode === "window") {
        const w = hoverWin || { x: 0, y: 0, w: frame.w, h: frame.h };
        const rect = { x: w.x, y: w.y, w: w.w, h: w.h };
        if (editDefault || e.shiftKey) enterEdit(rect);
        else { selF = rect; finish(false); }
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
    if (phase === "drag") {
      const tooSmall = selF.w / sx < 5 || selF.h / sy < 5;
      if (tooSmall) { resetUi(); return; }   // a stray click: start over, do not cancel the capture
      if (editDefault || e.shiftKey) enterEdit(selF);
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
    if (e.key === "Escape") { cancel(); return; }
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
