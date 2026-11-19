// overlay.js: runs in one hidden full-screen window per monitor. The Rust side grabs the
// screen first, this window paints the frozen image, the user drags a region (optionally
// marking redaction boxes), and the result goes back to Rust, which wakes the main window.
(function () {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const idx = Number(new URLSearchParams(location.search).get("i") || 0);
  const canvas = document.getElementById("frame");
  const ctx = canvas.getContext("2d");
  const dim = document.getElementById("dim");
  const sel = document.getElementById("sel");
  const tag = document.getElementById("tag");
  const bar = document.getElementById("bar");
  const barText = document.getElementById("bartext");
  const hint = document.getElementById("hint");

  let frame = null;        // { w, h } physical pixels of the grabbed monitor
  let phase = "idle";      // "idle" | "select" | "selected" | "redact"
  let start = null;        // drag start, CSS px
  let rect = null;         // selection, CSS px { x, y, w, h }
  let redactMode = false;
  let rboxes = [];         // { el, x, y, w, h } CSS px
  let drawing = null;      // redaction box being drawn

  function wantRedaction() {
    try {
      return !!JSON.parse(localStorage.getItem("snipziSettings") || "{}").redactionEnabled;
    } catch (e) {
      return false;
    }
  }

  function resetUi() {
    phase = "idle";
    start = null;
    rect = null;
    drawing = null;
    rboxes.forEach((b) => b.el.remove());
    rboxes = [];
    sel.style.display = "none";
    tag.style.display = "none";
    bar.style.display = "none";
    dim.style.display = "block";
    hint.style.display = "block";
  }

  listen("overlay:frame", async () => {
    resetUi();
    redactMode = wantRedaction();
    try {
      const buf = await invoke("get_frame", { idx });
      const dv = new DataView(buf);
      const w = dv.getUint32(0, true);
      const h = dv.getUint32(4, true);
      canvas.width = w;
      canvas.height = h;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(buf, 8, w * h * 4), w, h), 0, 0);
      frame = { w, h };
    } catch (e) {
      await invoke("cancel_capture");
      return;
    }
    await invoke("overlay_ready");
    window.focus();
  });

  function cssToFrame(r) {
    const sx = frame.w / window.innerWidth;
    const sy = frame.h / window.innerHeight;
    return { x: Math.round(r.x * sx), y: Math.round(r.y * sy), w: Math.round(r.w * sx), h: Math.round(r.h * sy), sx, sy };
  }

  function norm(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }

  function place(el, r) {
    el.style.left = r.x + "px";
    el.style.top = r.y + "px";
    el.style.width = r.w + "px";
    el.style.height = r.h + "px";
  }

  function clampToSel(p) {
    return { x: Math.min(Math.max(p.x, rect.x), rect.x + rect.w), y: Math.min(Math.max(p.y, rect.y), rect.y + rect.h) };
  }

  function updateTag(r) {
    const f = cssToFrame(r);
    tag.textContent = f.w + " x " + f.h;
    tag.style.display = "block";
    tag.style.left = r.x + "px";
    tag.style.top = Math.max(0, r.y - 24) + "px";
  }

  async function cancel() {
    resetUi();
    await invoke("cancel_capture");
  }

  async function finish() {
    if (!rect || !frame) return;
    const f = cssToFrame(rect);
    const redactions = rboxes
      .map((b) => {
        const rx = Math.round((b.x - rect.x) * f.sx);
        const ry = Math.round((b.y - rect.y) * f.sy);
        return [Math.max(0, rx), Math.max(0, ry), Math.round(b.w * f.sx), Math.round(b.h * f.sy)];
      })
      .filter((r) => r[2] > 0 && r[3] > 0);
    const result = {
      idx,
      x: Math.max(0, Math.min(f.x, frame.w - 1)),
      y: Math.max(0, Math.min(f.y, frame.h - 1)),
      w: Math.max(1, Math.min(f.w, frame.w - f.x)),
      h: Math.max(1, Math.min(f.h, frame.h - f.y)),
      redactions
    };
    resetUi();
    await invoke("finish_region", { result });
  }

  window.addEventListener("mousedown", (e) => {
    if (!frame) return;
    if (e.button === 2) {
      cancel();
      return;
    }
    if (e.button !== 0) return;
    if (phase === "idle") {
      phase = "select";
      start = { x: e.clientX, y: e.clientY };
      hint.style.display = "none";
      dim.style.display = "none";
      sel.style.display = "block";
      place(sel, { x: start.x, y: start.y, w: 0, h: 0 });
    } else if (phase === "redact") {
      const hit = e.target && e.target.classList && e.target.classList.contains("rbox");
      if (hit) {
        const i = rboxes.findIndex((b) => b.el === e.target);
        if (i >= 0) {
          rboxes[i].el.remove();
          rboxes.splice(i, 1);
        }
        return;
      }
      const p = { x: e.clientX, y: e.clientY };
      if (p.x < rect.x || p.x > rect.x + rect.w || p.y < rect.y || p.y > rect.y + rect.h) return;
      const el = document.createElement("div");
      el.className = "rbox";
      document.body.appendChild(el);
      drawing = { el, from: p };
      place(el, { x: p.x, y: p.y, w: 0, h: 0 });
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (phase === "select") {
      const r = norm(start, { x: e.clientX, y: e.clientY });
      place(sel, r);
      updateTag(r);
    } else if (phase === "redact" && drawing) {
      const a = drawing.from;
      const b = clampToSel({ x: e.clientX, y: e.clientY });
      place(drawing.el, norm(a, b));
    }
  });

  window.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;
    if (phase === "select") {
      const r = norm(start, { x: e.clientX, y: e.clientY });
      if (r.w < 5 || r.h < 5) {
        // A stray click: start over instead of cancelling the whole capture.
        resetUi();
        return;
      }
      rect = r;
      place(sel, r);
      updateTag(r);
      if (redactMode) {
        phase = "redact";
        barText.textContent = "Drag to hide areas. Click a black box to remove it.";
        bar.style.display = "block";
        bar.style.left = Math.max(0, Math.min(r.x, window.innerWidth - 480)) + "px";
        bar.style.top = Math.min(r.y + r.h + 8, window.innerHeight - 44) + "px";
      } else {
        finish();
      }
    } else if (phase === "redact" && drawing) {
      const el = drawing.el;
      const x = parseFloat(el.style.left), y = parseFloat(el.style.top);
      const w = parseFloat(el.style.width), h = parseFloat(el.style.height);
      if (w < 4 || h < 4) {
        el.remove();
      } else {
        rboxes.push({ el, x, y, w, h });
      }
      drawing = null;
    }
  });

  window.addEventListener("contextmenu", (e) => e.preventDefault());

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      cancel();
    } else if (e.key === "Enter" && phase === "redact") {
      finish();
    }
  });

  document.getElementById("done").addEventListener("mousedown", (e) => e.stopPropagation());
  document.getElementById("cancel").addEventListener("mousedown", (e) => e.stopPropagation());
  document.getElementById("done").addEventListener("click", () => finish());
  document.getElementById("cancel").addEventListener("click", () => cancel());
})();
