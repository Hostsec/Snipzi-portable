// annotate.js: draws editor annotations. The same code paints the live preview in the capture
// overlay and the final saved image, so what you see in the editor is what gets saved.
//
// Shapes use monitor pixel coordinates:
//   arrow  {t, x1, y1, x2, y2, c, w}      rect/ellipse {t, x, y, w, h, c, lw}
//   pen/hl {t, pts:[[x,y]...], c, lw}     text {t, x, y, text, c, size}
//   step   {t, x, y, n, c, r}             blur/hide {t, x, y, w, h}
(function (global) {
  const BLUR_BLOCK = 14;

  function rgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    const n = m ? parseInt(m[1], 16) : 0xe5383b;
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  function pixelate(ctx, src, x, y, w, h) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    if (w < 1 || h < 1) return;
    const sw = Math.max(1, Math.ceil(w / BLUR_BLOCK));
    const sh = Math.max(1, Math.ceil(h / BLUR_BLOCK));
    const tmp = new OffscreenCanvas(sw, sh);
    const t = tmp.getContext("2d");
    t.imageSmoothingEnabled = true;
    t.drawImage(src, x, y, w, h, 0, 0, sw, sh);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, sw, sh, x, y, sw * BLUR_BLOCK, sh * BLUR_BLOCK);
    ctx.restore();
  }

  function drawArrow(ctx, s) {
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    const len = Math.hypot(dx, dy);
    if (len < 2) return;
    const ux = dx / len, uy = dy / len;
    const head = Math.min(len * 0.9, Math.max(14, s.w * 4.5));
    const half = head * 0.45;
    const bx = s.x2 - ux * head, by = s.y2 - uy * head;
    ctx.strokeStyle = s.c;
    ctx.fillStyle = s.c;
    ctx.lineWidth = s.w;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(bx - uy * half, by + ux * half);
    ctx.lineTo(bx + uy * half, by - ux * half);
    ctx.closePath();
    ctx.fill();
  }

  function drawPath(ctx, pts, color, lw, cap) {
    if (!pts || pts.length < 1) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineCap = cap;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }

  function drawShapes(ctx, shapes, src) {
    for (const s of shapes || []) {
      ctx.save();
      switch (s.t) {
        case "hide":
          ctx.fillStyle = "#000";
          ctx.fillRect(s.x, s.y, s.w, s.h);
          break;
        case "blur":
          pixelate(ctx, src, s.x, s.y, s.w, s.h);
          break;
        case "rect":
          ctx.strokeStyle = s.c;
          ctx.lineWidth = s.lw;
          ctx.lineJoin = "round";
          ctx.strokeRect(s.x, s.y, s.w, s.h);
          break;
        case "ellipse":
          ctx.strokeStyle = s.c;
          ctx.lineWidth = s.lw;
          ctx.beginPath();
          ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w / 2), Math.abs(s.h / 2), 0, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case "arrow":
          drawArrow(ctx, s);
          break;
        case "pen":
          drawPath(ctx, s.pts, s.c, s.lw, "round");
          break;
        case "hl":
          drawPath(ctx, s.pts, rgba(s.c, 0.38), s.lw, "butt");
          break;
        case "text": {
          ctx.fillStyle = s.c;
          ctx.font = "600 " + s.size + 'px "Segoe UI", Arial, sans-serif';
          ctx.textBaseline = "top";
          String(s.text || "").split("\n").forEach((line, i) => ctx.fillText(line, s.x, s.y + i * s.size * 1.25));
          break;
        }
        case "step": {
          ctx.fillStyle = s.c;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#fff";
          ctx.font = "700 " + Math.round(s.r * 1.2) + 'px "Segoe UI", Arial, sans-serif';
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(s.n), s.x, s.y + s.r * 0.06);
          break;
        }
        default:
          break;
      }
      ctx.restore();
    }
  }

  global.SnipziAnnotate = { drawShapes, rgba };
})(window);
