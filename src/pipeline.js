// pipeline.js: image pipeline ported unchanged from the extension's lib.js (v1.13.3).
// Watermark, format conversion, PDF, filename templates, thumbnails, ImgBay.
class SnipziExpectedError extends Error { constructor(m) { super(m); this.name = 'SnipziExpectedError'; } }

function fpsBlobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read cropped image data."));
    reader.readAsDataURL(blob);
  });
}


function fpsExtensionForFormat(format) {
  if (format === "jpeg") return "jpg";
  if (format === "webp") return "webp";
  if (format === "pdf") return "pdf";
  return "png";
}

function fpsMimeForFormat(format) {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

// ===========================================================================
// FORMAT CONVERSION — re-encodes the (always-PNG) captured image as JPEG/WebP
// if requested. Uses OffscreenCanvas, same as the cropping helper, so it
// works identically from the popup and the background service worker.
// PDF is a special case: it wraps a JPEG-encoded version of the same image
// (see fpsBuildPdfFromJpeg below) rather than going through canvas encoding.
// ===========================================================================

async function fpsConvertDataUrl(dataUrl, format, quality) {
  if (format === "png") return dataUrl; // stitch/crop already produce PNG
  if (format === "pdf") {
    const jpegDataUrl = await fpsConvertDataUrl(dataUrl, "jpeg", quality);
    return fpsBuildPdfFromJpeg(jpegDataUrl);
  }
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const outBlob = await canvas.convertToBlob({ type: fpsMimeForFormat(format), quality });
  return fpsBlobToDataUrl(outBlob);
}

// ===========================================================================
// PDF EXPORT — builds a minimal, valid single-page PDF that wraps a JPEG
// image directly, using the DCTDecode filter so the JPEG bytes are embedded
// unchanged (no re-encoding, no external library, no bundled dependency).
// The page is sized to the image's pixel dimensions at an assumed 96 DPI
// (the standard CSS/screen DPI), so the PDF page matches the screenshot's
// proportions exactly rather than fitting it onto a fixed paper size.
// ===========================================================================

function fpsPdfTextBytes(str) {
  return new TextEncoder().encode(str);
}

async function fpsBuildPdfFromJpeg(jpegDataUrl, dpi) {
  const assumedDpi = dpi || 96;

  const res = await fetch(jpegDataUrl);
  const jpegBlob = await res.blob();
  const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
  const bitmap = await createImageBitmap(jpegBlob);
  const w = bitmap.width, h = bitmap.height;

  const pageW = (w * 72 / assumedDpi).toFixed(2);
  const pageH = (h * 72 / assumedDpi).toFixed(2);

  const chunks = [];
  const offsets = [0]; // offsets[i] = byte offset of object i; index 0 unused (free entry)
  let offset = 0;

  function push(bytes) {
    chunks.push(bytes);
    offset += bytes.length;
  }

  push(fpsPdfTextBytes("%PDF-1.4\n"));
  push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // conventional binary-content marker comment

  offsets[1] = offset;
  push(fpsPdfTextBytes("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"));

  offsets[2] = offset;
  push(fpsPdfTextBytes("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"));

  offsets[3] = offset;
  push(fpsPdfTextBytes(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + pageW + " " + pageH + "] " +
    "/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n"
  ));

  offsets[4] = offset;
  push(fpsPdfTextBytes(
    "4 0 obj\n<< /Type /XObject /Subtype /Image /Width " + w + " /Height " + h +
    " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + jpegBytes.length + " >>\nstream\n"
  ));
  push(jpegBytes);
  push(fpsPdfTextBytes("\nendstream\nendobj\n"));

  const contentStr = "q " + pageW + " 0 0 " + pageH + " 0 0 cm /Im0 Do Q";
  const contentBytes = fpsPdfTextBytes(contentStr);
  offsets[5] = offset;
  push(fpsPdfTextBytes("5 0 obj\n<< /Length " + contentBytes.length + " >>\nstream\n"));
  push(contentBytes);
  push(fpsPdfTextBytes("\nendstream\nendobj\n"));

  const xrefOffset = offset;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) {
    xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  push(fpsPdfTextBytes(xref));
  push(fpsPdfTextBytes("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF"));

  const pdfBlob = new Blob(chunks, { type: "application/pdf" });
  return fpsBlobToDataUrl(pdfBlob);
}

async function fpsAddWatermark(dataUrl, text, opacity, style) {
  if (!text) return dataUrl;

  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const w = bitmap.width, h = bitmap.height;

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  const tiled = style === "tiled";
  const fontSize = Math.round(Math.min(w, h) * (tiled ? 0.045 : 0.09));
  ctx.font = `bold ${fontSize}px -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.fillStyle = `rgba(108, 74, 230, ${opacity})`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-Math.PI / 8); // roughly -22 degrees, the classic watermark angle

  if (tiled) {
    // Repeat the text across a grid large enough to cover the whole canvas
    // even after rotation (using the diagonal as the safe bound in every
    // direction from the rotated origin).
    const textWidth = ctx.measureText(text).width;
    const stepX = Math.max(textWidth, fontSize) + fontSize * 3;
    const stepY = fontSize * 4;
    const diag = Math.sqrt(w * w + h * h) / 2;
    for (let y = -diag; y <= diag; y += stepY) {
      for (let x = -diag; x <= diag; x += stepX) {
        ctx.fillText(text, x, y);
      }
    }
  } else {
    ctx.fillText(text, 0, 0);
  }

  ctx.restore();

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  return fpsBlobToDataUrl(outBlob);
}

function fpsSanitizeFilenameSegment(s) {
  return String(s || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .trim();
}

function fpsBuildFilename(template, kind, tokens, ext) {
  if (!template) {
    return `snipzi-${kind}-${(tokens && tokens.date) || "x"}_${(tokens && tokens.time) || Date.now()}.${ext}`;
  }
  let name = template;
  const allTokens = Object.assign({ type: kind }, tokens);
  for (const key of Object.keys(allTokens)) {
    name = name.split(`{${key}}`).join(fpsSanitizeFilenameSegment(String(allTokens[key])));
  }
  name = fpsSanitizeFilenameSegment(name).trim();
  if (!name) name = `snipzi-${Date.now()}`;
  return `${name}.${ext}`;
}

async function fpsMakeThumbnail(dataUrl, maxWidth) {
  const width = maxWidth || 160;
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, width / bitmap.width);
  const outW = Math.max(1, Math.round(bitmap.width * scale));
  const outH = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, outW, outH);
  const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
  return fpsBlobToDataUrl(outBlob);
}

function fpsFormatFileSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

const FPS_IMGBAY_DB = "snipzi";
const FPS_IMGBAY_STORE = "blobs";

function fpsIdbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FPS_IMGBAY_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(FPS_IMGBAY_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function fpsIdbPut(key, value) {
  const db = await fpsIdbOpen();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FPS_IMGBAY_STORE, "readwrite");
      tx.objectStore(FPS_IMGBAY_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function fpsIdbGet(key) {
  const db = await fpsIdbOpen();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(FPS_IMGBAY_STORE, "readonly").objectStore(FPS_IMGBAY_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Remembers the most recent capture's image bytes (only the latest one) for the Upload button. */
async function fpsStoreUploadCandidate(dataUrl, relativePath) {
  const blob = await (await fetch(dataUrl)).blob();
  const extByType = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
  const ext = extByType[blob.type] || "png";
  let name = String(relativePath || "snipzi").split("/").pop().replace(/\.[A-Za-z0-9]+$/, "");
  if (!name) name = "snipzi";
  await fpsIdbPut("last", { blob, filename: name + "." + ext, ts: Date.now() });
}

function fpsImgbayDecode(text) {
  return String(text)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&amp;/g, "&");
}

/** "img.example.com/imgbay" or ".../imgbay/index.php?x" -> "https://img.example.com/imgbay/". Throws if empty or not http(s). */
function fpsImgbayBase(raw) {
  let u = String(raw || "").trim();
  if (!u) throw new SnipziExpectedError("Enter your ImgBay address in Settings first.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "https://" + u;
  let url;
  try {
    url = new URL(u);
  } catch (e) {
    throw new SnipziExpectedError("The ImgBay address in Settings is not a valid web address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SnipziExpectedError("The ImgBay address must start with https:// or http://.");
  }
  let path = url.pathname.replace(/[^/]*\.php$/i, "");
  if (!path.endsWith("/")) path += "/";
  return url.origin + path;
}

async function fpsImgbayFetch(url, init) {
  // Desktop: the request runs in the Rust side (no browser CORS), carrying the ImgBay login
  // cookies from the in-app login window. Returns a minimal Response-like object.
  init = init || {};
  const args = { url, method: init.method || "GET", fields: [], file: null };
  if (init.body instanceof FormData) {
    for (const [k, v] of init.body.entries()) {
      if (v instanceof Blob) {
        const dataUrl = await fpsBlobToDataUrl(v);
        args.file = { name: k, filename: v.name || "image.png", mime: v.type || "image/png", b64: dataUrl.split(",")[1] };
      } else {
        args.fields.push([k, String(v)]);
      }
    }
  }
  let r;
  try {
    r = await window.__TAURI__.core.invoke("http_request", { args });
  } catch (e) {
    throw new SnipziExpectedError("Could not reach ImgBay at " + new URL(url).origin + ". Check the address in Settings and your connection.");
  }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body };
}

/** Loads the gallery page and returns { token, ids } if signed in with uploads available; otherwise throws a clear message. */
async function fpsImgbayOpenGallery(base) {
  const res = await fpsImgbayFetch(base + "?page=gallery");
  if (!res.ok) throw new SnipziExpectedError("ImgBay answered with an error (" + res.status + "). Check the address in Settings.");
  const html = await res.text();
  if (/name="a"\s+value="login"/.test(html) || /name="a"\s+value="setup"/.test(html)) {
    throw new SnipziExpectedError("Not logged in to ImgBay. Use the Log in to ImgBay button in Settings (tick Remember me), then try again.");
  }
  if (!/name="a"\s+value="upload"/.test(html)) {
    if (/Uploads are switched off/.test(html)) throw new SnipziExpectedError("Uploads are switched off on your ImgBay.");
    throw new SnipziExpectedError("That address does not look like an ImgBay gallery page. Check the address in Settings.");
  }
  const tok = /<input type="hidden" name="t" value="([^"]*)">/.exec(html);
  if (!tok) throw new SnipziExpectedError("Could not read ImgBay's security token. The ImgBay page layout may have changed.");
  return { token: fpsImgbayDecode(tok[1]), ids: fpsImgbayImageIds(html) };
}

function fpsImgbayImageIds(html) {
  const ids = [];
  const re = /\?page=image&(?:amp;)?id=([a-z0-9]{12})/g;
  let m;
  while ((m = re.exec(html))) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

/** For the Settings "Check login" button. Resolves to a short success message or throws SnipziExpectedError. */
async function fpsImgbayCheck(rawUrl) {
  const base = fpsImgbayBase(rawUrl);
  await fpsImgbayOpenGallery(base);
  return "Connected. You are logged in to ImgBay.";
}

/** Uploads one image blob. Returns { id, pageUrl, directUrl }. */
async function fpsUploadToImgBay(blob, filename, settings) {
  const base = fpsImgbayBase(settings.imgbayUrl);
  const before = await fpsImgbayOpenGallery(base);

  const form = new FormData();
  form.append("a", "upload");
  form.append("t", before.token);
  form.append("exp", settings.imgbayExpiry || "7d");
  form.append("views", "0");
  form.append("vis", settings.imgbayVisibility === "private" ? "private" : "link");
  form.append("imgs[]", blob, filename);

  const res = await fpsImgbayFetch(base, { method: "POST", body: form });
  if (res.status === 413) throw new SnipziExpectedError("The image is larger than your ImgBay server accepts.");
  const html = await res.text();

  const flash = /<div class="flash (ok|bad)" role="status">([\s\S]*?)<\/div>/.exec(html);
  if (flash && flash[1] === "bad") throw new SnipziExpectedError("ImgBay: " + fpsImgbayDecode(flash[2]).trim());
  if (/name="a"\s+value="login"/.test(html)) {
    throw new SnipziExpectedError("Your ImgBay login ended. Use the Log in to ImgBay button in Settings, then retry.");
  }
  if (!flash) {
    if (/form has expired/i.test(html)) throw new SnipziExpectedError("ImgBay refused the upload form (expired). Please try again.");
    throw new SnipziExpectedError("ImgBay did not confirm the upload (HTTP " + res.status + "). Check your ImgBay gallery.");
  }

  // The new image is the first one on the gallery page that was not there before.
  let id = fpsImgbayImageIds(html).find((x) => !before.ids.includes(x));
  if (!id) {
    const again = await fpsImgbayOpenGallery(base);
    id = again.ids.find((x) => !before.ids.includes(x));
  }
  if (!id) throw new SnipziExpectedError("Uploaded, but Snipzi could not find the new link. Look in your ImgBay gallery.");

  // The image's own page lists the ready-made links (first = direct link, last = page link).
  let pageUrl = base + "view.php?id=" + id;
  let directUrl = "";
  try {
    const ir = await fpsImgbayFetch(base + "?page=image&id=" + id);
    const ihtml = await ir.text();
    const vals = [];
    const re = /readonly value="([^"]*)"/g;
    let m;
    while ((m = re.exec(ihtml))) vals.push(fpsImgbayDecode(m[1]));
    const direct = vals.find((v) => /\/i\/[a-z0-9]{12}\.[a-z]+$/.test(v));
    const page = vals.find((v) => /view\.php\?id=[a-z0-9]{12}$/.test(v));
    if (direct) directUrl = direct;
    if (page) pageUrl = page;
  } catch (e) {
    if (!(e instanceof SnipziExpectedError)) throw e;
  }
  return { id, pageUrl, directUrl };
}
