// app.js: main window. Owns settings, the image pipeline run, history and the ImgBay upload.
// The Rust side hands over raw screen pixels; everything after that reuses pipeline.js.
(function () {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------
  const DEFAULTS = {
    hotkeyRegion: "Ctrl+Shift+1",
    hotkeyScreen: "Ctrl+Shift+2",
    hotkeyWindow: "Ctrl+Shift+3",
    hotkeyUpload: "Ctrl+Shift+4",
    editBeforeSave: false,
    delaySeconds: 0,
    keepOverlays: true,
    popupEnabled: false,
    popupSeconds: 6,
    saveToFile: true,
    saveDir: "",
    copyToClipboard: true,
    notify: true,
    historyEnabled: true,
    watermarkEnabled: false,
    watermarkText: "",
    watermarkOpacity: 0.25,
    watermarkStyle: "single",
    format: "png",
    quality: 0.92,
    folderTemplate: "",
    filenameTemplate: "",
    imgbayUrl: "",
    imgbayExpiry: "7d",
    imgbayVisibility: "link",
    imgbayAuto: false
  };
  const HISTORY_LIMIT = 20;

  function getSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem("snipziSettings") || "{}");
      // 0.1.x had a "mark areas to hide" switch; the editor now covers that.
      if (saved.redactionEnabled && saved.editBeforeSave === undefined) saved.editBeforeSave = true;
      return Object.assign({}, DEFAULTS, saved);
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }
  function setSettings(partial) {
    const next = Object.assign(getSettings(), partial);
    localStorage.setItem("snipziSettings", JSON.stringify(next));
    return next;
  }
  function readJson(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v === null || v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  let toastTimer = null;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
  }
  function b64(str) {
    const bytes = new TextEncoder().encode(str);
    let s = "";
    bytes.forEach((b) => (s += String.fromCharCode(b)));
    return btoa(s);
  }
  function pad2(n) {
    return String(n).padStart(2, "0");
  }
  function baseName(p) {
    return String(p || "").split(/[\\/]/).pop();
  }
  function msgOf(e) {
    return e && e.message ? e.message : String(e);
  }
  function notifyNative(title, body) {
    invoke("notify_user", { title, body }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Capture pipeline
  // -------------------------------------------------------------------------
  async function fetchFrame(idx) {
    const buf = await invoke("get_frame", { idx });
    const dv = new DataView(buf);
    const w = dv.getUint32(0, true);
    const h = dv.getUint32(4, true);
    return { w, h, data: new Uint8ClampedArray(buf, 8, w * h * 4) };
  }

  /** Crops the frame, draws the user's annotations on it and returns a PNG data URL. */
  async function renderCrop(frame, rect, shapes) {
    const full = new OffscreenCanvas(frame.w, frame.h);
    full.getContext("2d").putImageData(new ImageData(frame.data, frame.w, frame.h), 0, 0);
    const canvas = new OffscreenCanvas(rect.w, rect.h);
    const ctx = canvas.getContext("2d");
    ctx.translate(-rect.x, -rect.y);
    ctx.drawImage(full, 0, 0);
    if (shapes && shapes.length) window.SnipziAnnotate.drawShapes(ctx, shapes, full);
    return fpsBlobToDataUrl(await canvas.convertToBlob({ type: "image/png" }));
  }

  function tokensNow() {
    const n = new Date();
    return {
      date: `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`,
      time: `${pad2(n.getHours())}-${pad2(n.getMinutes())}-${pad2(n.getSeconds())}`,
      year: String(n.getFullYear()),
      month: pad2(n.getMonth() + 1)
    };
  }

  function buildFolder(template, tokens, kind) {
    const t = Object.assign({ type: kind }, tokens);
    let s = String(template || "");
    for (const k of Object.keys(t)) s = s.split("{" + k + "}").join(t[k]);
    return s
      .split(/[\\/]/)
      .map((seg) => seg.replace(/[<>:"|?*\x00-\x1F]/g, "").replace(/\.\./g, "").trim())
      .filter(Boolean)
      .join("/");
  }

  async function copyImageToClipboard(dataUrl) {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    await invoke("copy_image", new Uint8Array(px.data.buffer), {
      headers: { "x-w": String(bitmap.width), "x-h": String(bitmap.height) }
    });
  }

  async function dataUrlToBytes(dataUrl) {
    return new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
  }

  /** Everything after the pixels exist: watermark, format, name, save, clipboard, history. */
  async function finalizeCapture(rawDataUrl, kind, opts) {
    opts = opts || {};
    const s = getSettings();
    let working = rawDataUrl;

    if (s.watermarkEnabled && s.watermarkText) {
      working = await fpsAddWatermark(working, s.watermarkText, s.watermarkOpacity, s.watermarkStyle);
    }

    const finalDataUrl = await fpsConvertDataUrl(working, s.format, s.quality);
    const ext = fpsExtensionForFormat(s.format);

    let dimensions = null;
    let fileSizeBytes = null;
    try {
      const finalBlob = await (await fetch(finalDataUrl)).blob();
      fileSizeBytes = finalBlob.size;
      const dimBlob = s.format === "pdf" ? await (await fetch(working)).blob() : finalBlob;
      const bmp = await createImageBitmap(dimBlob);
      dimensions = { width: bmp.width, height: bmp.height };
    } catch (e) {
      // size/dimensions are informational only
    }

    const tokens = tokensNow();
    const fileName = fpsBuildFilename(s.filenameTemplate, kind, tokens, ext);
    const folder = buildFolder(s.folderTemplate, tokens, kind);
    const relPath = folder ? folder + "/" + fileName : fileName;

    let savedPath = null;
    if (s.saveToFile) {
      savedPath = await invoke("save_file", await dataUrlToBytes(finalDataUrl), {
        headers: { "x-dir": b64(s.saveDir || ""), "x-path": b64(relPath) }
      });
    }

    let copied = false;
    if (s.copyToClipboard) {
      try {
        await copyImageToClipboard(working);
        copied = true;
      } catch (e) {
        toast("Could not copy to the clipboard: " + msgOf(e));
      }
    }

    // Keep the image for a later "Upload to ImgBay" click (a PDF cannot go to an image host).
    await fpsStoreUploadCandidate(s.format === "pdf" ? working : finalDataUrl, savedPath || relPath).catch(() => {});

    const thumb = await fpsMakeThumbnail(working).catch(() => null);
    const record = {
      path: savedPath,
      name: savedPath ? baseName(savedPath) : fileName,
      thumb,
      dimensions,
      fileSizeBytes,
      ts: Date.now()
    };
    localStorage.setItem("snipziLast", JSON.stringify(record));
    if (s.historyEnabled) {
      const history = readJson("snipziHistory", []);
      history.unshift(record);
      while (history.length > HISTORY_LIMIT) history.pop();
      try {
        localStorage.setItem("snipziHistory", JSON.stringify(history));
      } catch (e) {
        // storage full: drop the oldest half and retry once
        localStorage.setItem("snipziHistory", JSON.stringify(history.slice(0, Math.floor(history.length / 2))));
      }
    }
    renderLast();
    renderHistory();

    const wantUpload = !!(s.imgbayUrl && (s.imgbayAuto || opts.upload));
    const parts = [];
    if (savedPath) parts.push("Saved " + record.name);
    if (copied) parts.push("copied to clipboard");
    const summary = parts.length ? parts.join(", ") : "Captured";

    if (s.popupEnabled) {
      invoke("show_popup", {
        payload: {
          thumb, name: record.name, meta: metaText(record), path: record.path,
          canUpload: !!s.imgbayUrl && !wantUpload, seconds: s.popupSeconds,
          msg: wantUpload ? "Uploading..." : summary
        }
      }).catch(() => {});
    } else if (s.notify) {
      notifyNative("Snipzi", summary);
    }

    if (opts.upload && !s.imgbayUrl) {
      toast("Add your ImgBay address in Settings to upload.");
      notifyNative("Snipzi", "Saved, but not uploaded: add your ImgBay address in Settings.");
    }
    if (wantUpload) uploadLast(!opts.upload).catch(() => {});
    return record;
  }

  async function handleRegion(p) {
    try {
      const frame = await fetchFrame(p.idx);
      const raw = await renderCrop(frame, { x: p.x, y: p.y, w: p.w, h: p.h }, p.shapes);
      await finalizeCapture(raw, p.kind === "window" ? "window" : "region", { upload: !!p.upload });
    } catch (e) {
      toast("Capture failed: " + msgOf(e));
      notifyNative("Snipzi", "Capture failed: " + msgOf(e));
    } finally {
      invoke("release_frames").catch(() => {});
    }
  }

  async function handleScreen(p) {
    try {
      const frame = await fetchFrame(p.idx);
      const raw = await renderCrop(frame, { x: 0, y: 0, w: frame.w, h: frame.h }, []);
      await finalizeCapture(raw, "screen", { upload: !!p.upload });
    } catch (e) {
      toast("Capture failed: " + msgOf(e));
      notifyNative("Snipzi", "Capture failed: " + msgOf(e));
    } finally {
      invoke("release_frames").catch(() => {});
    }
  }

  // exposed for tests
  window.__snipzi = { renderCrop, finalizeCapture, getSettings, setSettings, handleRegion, handleScreen };

  // -------------------------------------------------------------------------
  // ImgBay upload
  // -------------------------------------------------------------------------
  function popupFromLast(msg) {
    const r = readJson("snipziLast", {}) || {};
    return { thumb: r.thumb, name: r.name, meta: metaText(r), path: r.path, canUpload: false, seconds: getSettings().popupSeconds, msg };
  }

  async function uploadLast(auto) {
    const s = getSettings();
    try {
      fpsImgbayBase(s.imgbayUrl);
      const rec = await fpsIdbGet("last").catch(() => null);
      if (!rec || !rec.blob) throw new SnipziExpectedError("There is no screenshot to upload yet. Take one first.");
      const result = await fpsUploadToImgBay(rec.blob, rec.filename, s);
      const last = readJson("snipziLast", null);
      if (last) {
        last.imgbay = { pageUrl: result.pageUrl, directUrl: result.directUrl, ts: Date.now() };
        localStorage.setItem("snipziLast", JSON.stringify(last));
        const history = readJson("snipziHistory", []);
        if (history.length && history[0].ts === last.ts) {
          history[0].imgbay = last.imgbay;
          localStorage.setItem("snipziHistory", JSON.stringify(history));
        }
      }
      const link = result.directUrl || result.pageUrl;
      await invoke("copy_text", { text: link }).catch(() => {});
      renderLast();
      if (!auto) toast("Uploaded. Link copied.");
      if (getSettings().popupEnabled) {
        invoke("show_popup", { payload: popupFromLast("Uploaded. Link copied.") }).catch(() => {});
      } else if (getSettings().notify || !auto) {
        notifyNative("Snipzi", "Uploaded to ImgBay. Link copied.");
      }
      return result;
    } catch (e) {
      const m = msgOf(e);
      toast(m);
      if (auto) notifyNative("Snipzi", "ImgBay upload failed: " + m);
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Rendering: last screenshot + history
  // -------------------------------------------------------------------------
  function metaText(r) {
    const parts = [];
    if (r.dimensions) parts.push(r.dimensions.width + " x " + r.dimensions.height);
    if (r.fileSizeBytes !== null && r.fileSizeBytes !== undefined) parts.push(fpsFormatFileSize(r.fileSizeBytes));
    return parts.join(", ");
  }

  function renderLast() {
    const r = readJson("snipziLast", null);
    const card = $("last-card");
    if (!r) {
      card.classList.add("hidden");
      return;
    }
    card.classList.remove("hidden");
    $("last-thumb").src = r.thumb || "";
    $("last-name").textContent = r.name || "";
    $("last-meta").textContent = metaText(r) + (r.path ? "" : (metaText(r) ? ", " : "") + "not saved to a file");
    $("last-open").disabled = !r.path;
    $("last-folder").disabled = !r.path;
    $("last-upload").classList.toggle("hidden", !getSettings().imgbayUrl);
    const links = $("last-links");
    links.innerHTML = "";
    if (r.imgbay) {
      links.classList.remove("hidden");
      const add = (label, url) => {
        if (!url) return;
        const a = document.createElement("a");
        a.textContent = label;
        a.addEventListener("click", () => invoke("open_url", { url }).catch((e) => toast(msgOf(e))));
        const c = document.createElement("a");
        c.textContent = "copy";
        c.style.marginLeft = "6px";
        c.addEventListener("click", () => invoke("copy_text", { text: url }).then(() => toast("Link copied")));
        const wrap = document.createElement("div");
        wrap.appendChild(a);
        wrap.appendChild(c);
        links.appendChild(wrap);
      };
      add("Direct link", r.imgbay.directUrl);
      add("Page link", r.imgbay.pageUrl);
    } else {
      links.classList.add("hidden");
    }
  }

  let clearArmed = false;
  function renderHistory() {
    const s = getSettings();
    $("hist-toggle").textContent = "History: " + (s.historyEnabled ? "On" : "Off");
    const list = $("hist-list");
    list.innerHTML = "";
    const history = readJson("snipziHistory", []);
    $("hist-empty").classList.toggle("hidden", history.length > 0);
    history.forEach((r) => {
      const item = document.createElement("div");
      item.className = "hist-item";
      const img = document.createElement("img");
      img.src = r.thumb || "";
      const info = document.createElement("div");
      info.className = "info";
      const name = document.createElement("div");
      name.className = "file";
      name.textContent = r.name || "";
      const meta = document.createElement("div");
      meta.className = "muted small";
      meta.textContent = [metaText(r), new Date(r.ts).toLocaleString()].filter(Boolean).join(", ");
      info.appendChild(name);
      info.appendChild(meta);
      const acts = document.createElement("div");
      acts.className = "actions2";
      const mk = (label, fn, disabled) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.disabled = !!disabled;
        b.addEventListener("click", fn);
        acts.appendChild(b);
      };
      mk("Open", () => invoke("open_path", { path: r.path }).catch((e) => toast("Could not open it: " + msgOf(e))), !r.path);
      mk("Folder", () => invoke("reveal_path", { path: r.path }).catch((e) => toast("Could not show it: " + msgOf(e))), !r.path);
      mk("Remove", () => {
        const next = readJson("snipziHistory", []).filter((h) => h.ts !== r.ts);
        localStorage.setItem("snipziHistory", JSON.stringify(next));
        renderHistory();
      });
      item.appendChild(img);
      item.appendChild(info);
      item.appendChild(acts);
      list.appendChild(item);
    });
  }

  // -------------------------------------------------------------------------
  // Shortcuts
  // -------------------------------------------------------------------------
  const KEY_NAMES = { Space: "Space", PrintScreen: "PrintScreen", Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Tab: "Tab", Enter: "Enter" };

  function accelFromEvent(e) {
    let key = null;
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
    else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code;
    else if (KEY_NAMES[e.code]) key = KEY_NAMES[e.code];
    if (!key) return null;
    const mods = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Super");
    const bare = /^F\d+$/.test(key) || key === "PrintScreen";
    if (!mods.length && !bare) return null; // plain letters would break typing everywhere
    return mods.concat(key).join("+");
  }

  async function applyHotkeys(showError) {
    const s = getSettings();
    try {
      await invoke("set_hotkeys", { keys: { region: s.hotkeyRegion, screen: s.hotkeyScreen, window: s.hotkeyWindow, upload: s.hotkeyUpload } });
      $("hk-error").classList.add("hidden");
      return true;
    } catch (e) {
      if (showError) {
        $("hk-error").textContent = msgOf(e) + " Another app may already use that combination.";
        $("hk-error").classList.remove("hidden");
      }
      return false;
    }
  }

  const HOTKEYS = [
    ["hk-region", "hotkeyRegion", "hk-region-label"],
    ["hk-window", "hotkeyWindow", "hk-window-label"],
    ["hk-screen", "hotkeyScreen", "hk-screen-label"],
    ["hk-upload", "hotkeyUpload", "hk-upload-label"]
  ];
  function refreshHotkeyLabels() {
    const s = getSettings();
    HOTKEYS.forEach(([input, key, label]) => {
      $(input).value = s[key];
      $(label).textContent = s[key] || "no shortcut";
    });
  }

  function wireHotkeyInput(id, key) {
    const input = $(id);
    input.addEventListener("keydown", async (e) => {
      e.preventDefault();
      if (e.key === "Backspace" || e.key === "Delete") {
        const prev = getSettings()[key];
        setSettings({ [key]: "" });
        refreshHotkeyLabels();
        if (!(await applyHotkeys(true))) setSettings({ [key]: prev });
        return;
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const accel = accelFromEvent(e);
      if (!accel) {
        $("hk-error").textContent = "Use at least one of Ctrl, Alt or Shift together with a key.";
        $("hk-error").classList.remove("hidden");
        return;
      }
      const prev = getSettings()[key];
      setSettings({ [key]: accel });
      if (await applyHotkeys(true)) {
        refreshHotkeyLabels();
      } else {
        setSettings({ [key]: prev });
        await applyHotkeys(false);
        refreshHotkeyLabels();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Settings form
  // -------------------------------------------------------------------------
  const CHECKS = ["saveToFile", "copyToClipboard", "notify", "popupEnabled", "editBeforeSave", "keepOverlays", "watermarkEnabled", "imgbayAuto"];
  const TEXTS = ["saveDir", "watermarkText", "filenameTemplate", "folderTemplate", "imgbayUrl"];
  const SELECTS = ["watermarkStyle", "format", "imgbayExpiry", "imgbayVisibility"];
  const RANGES = ["watermarkOpacity", "quality", "popupSeconds"];

  function pushOptions() {
    const s = getSettings();
    invoke("set_options", {
      options: { edit_before_save: !!s.editBeforeSave, delay_secs: Number(s.delaySeconds) || 0, keep_overlays: !!s.keepOverlays }
    }).catch(() => {});
  }

  function initDelay() {
    const apply = () => {
      const d = Number(getSettings().delaySeconds) || 0;
      document.querySelectorAll("[data-delay]").forEach((b) => b.classList.toggle("on", Number(b.dataset.delay) === d));
      $("c-edit").checked = !!getSettings().editBeforeSave;
      $("s-editBeforeSave").checked = !!getSettings().editBeforeSave;
    };
    document.querySelectorAll("[data-delay]").forEach((b) =>
      b.addEventListener("click", () => {
        setSettings({ delaySeconds: Number(b.dataset.delay) });
        apply();
        pushOptions();
      })
    );
    $("c-edit").addEventListener("change", (e) => {
      setSettings({ editBeforeSave: e.target.checked });
      apply();
      pushOptions();
    });
    $("s-editBeforeSave").addEventListener("change", apply);
    apply();
  }

  function exampleName() {
    const s = getSettings();
    const t = tokensNow();
    const ext = fpsExtensionForFormat(s.format);
    const folder = buildFolder(s.folderTemplate || "", t, "region");
    const name = fpsBuildFilename(s.filenameTemplate, "region", t, ext);
    return (folder ? folder + "/" : "") + name;
  }

  function initTokens() {
    document.querySelectorAll("[data-token]").forEach((b) =>
      b.addEventListener("click", () => {
        const input = $(b.dataset.target);
        input.value += b.dataset.token;
        input.dispatchEvent(new Event("input"));
      })
    );
  }

  function syncDependentUi() {
    const s = getSettings();
    $("example-name").textContent = exampleName();
    $("popup-opts").style.opacity = s.popupEnabled ? "1" : "0.5";
    $("wm-opts").style.opacity = s.watermarkEnabled ? "1" : "0.5";
    $("q-row").classList.toggle("hidden", s.format === "png");
    $("wm-op-val").textContent = Math.round(s.watermarkOpacity * 100) + "%";
    $("popup-val").textContent = s.popupSeconds + " s";
    $("q-val").textContent = Math.round(s.quality * 100) + "%";
    $("last-upload").classList.toggle("hidden", !s.imgbayUrl || !readJson("snipziLast", null));
  }

  function initSettingsForm() {
    const s = getSettings();
    CHECKS.forEach((k) => {
      $("s-" + k).checked = !!s[k];
      $("s-" + k).addEventListener("change", (e) => {
        setSettings({ [k]: e.target.checked });
        if (k === "editBeforeSave" || k === "keepOverlays") pushOptions();
        syncDependentUi();
      });
    });
    pushOptions();
    TEXTS.forEach((k) => {
      $("s-" + k).value = s[k] || "";
      $("s-" + k).addEventListener("input", (e) => {
        setSettings({ [k]: e.target.value.trim() });
        syncDependentUi();
      });
    });
    SELECTS.forEach((k) => {
      $("s-" + k).value = s[k];
      $("s-" + k).addEventListener("change", (e) => {
        setSettings({ [k]: e.target.value });
        syncDependentUi();
      });
    });
    RANGES.forEach((k) => {
      $("s-" + k).value = s[k];
      $("s-" + k).addEventListener("input", (e) => {
        setSettings({ [k]: Number(e.target.value) });
        syncDependentUi();
      });
    });
    invoke("get_default_save_dir").then((d) => {
      $("s-saveDir").placeholder = d;
    }).catch(() => {});
    invoke("get_autostart").then((on) => {
      $("s-autostart").checked = !!on;
    }).catch(() => {});
    $("s-autostart").addEventListener("change", (e) => {
      invoke("set_autostart", { enabled: e.target.checked }).catch((err) => {
        toast("Could not change start at sign in: " + msgOf(err));
        e.target.checked = !e.target.checked;
      });
    });
    HOTKEYS.forEach(([input, key]) => wireHotkeyInput(input, key));
    document.querySelectorAll("[data-reset-hotkeys]").forEach((b) =>
      b.addEventListener("click", async () => {
        setSettings({ hotkeyRegion: DEFAULTS.hotkeyRegion, hotkeyScreen: DEFAULTS.hotkeyScreen, hotkeyWindow: DEFAULTS.hotkeyWindow, hotkeyUpload: DEFAULTS.hotkeyUpload });
        refreshHotkeyLabels();
        await applyHotkeys(true);
      })
    );
    initDelay();
    initTokens();
    $("browse-dir").addEventListener("click", async () => {
      const d = await invoke("pick_folder", { start: getSettings().saveDir || null }).catch(() => null);
      if (d) {
        setSettings({ saveDir: d });
        $("s-saveDir").value = d;
      }
    });
    $("open-dir").addEventListener("click", () =>
      invoke("open_save_folder", { dir: getSettings().saveDir || "" }).catch((e) => toast(msgOf(e)))
    );
    $("reset-dir").addEventListener("click", () => {
      setSettings({ saveDir: "" });
      $("s-saveDir").value = "";
    });
    refreshHotkeyLabels();
    syncDependentUi();
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------
  function showView(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
    if (name === "history") renderHistory();
  }

  function init() {
    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
    $("btn-region").addEventListener("click", () => invoke("start_capture", { mode: "region" }));
    $("btn-window").addEventListener("click", () => invoke("start_capture", { mode: "window" }));
    $("btn-screen").addEventListener("click", () => invoke("start_capture", { mode: "screen" }));
    $("btn-upload").addEventListener("click", () => invoke("start_capture", { mode: "upload" }));

    $("last-open").addEventListener("click", () => {
      const r = readJson("snipziLast", null);
      if (r && r.path) invoke("open_path", { path: r.path }).catch((e) => toast("Could not open it: " + msgOf(e)));
    });
    $("last-folder").addEventListener("click", () => {
      const r = readJson("snipziLast", null);
      if (r && r.path) invoke("reveal_path", { path: r.path }).catch((e) => toast("Could not show it: " + msgOf(e)));
    });
    $("last-copy").addEventListener("click", async () => {
      try {
        const rec = await fpsIdbGet("last");
        if (!rec || !rec.blob) throw new Error("Nothing to copy yet.");
        const url = await fpsBlobToDataUrl(rec.blob);
        await copyImageToClipboard(url);
        toast("Image copied");
      } catch (e) {
        toast(msgOf(e));
      }
    });
    $("last-upload").addEventListener("click", () => {
      $("last-upload").disabled = true;
      uploadLast(false).catch(() => {}).finally(() => ($("last-upload").disabled = false));
    });

    // Only clears the "Last screenshot" panel. The file and the History entry stay untouched.
    $("last-dismiss").addEventListener("click", () => {
      localStorage.removeItem("snipziLast");
      renderLast();
    });

    $("hist-toggle").addEventListener("click", () => {
      setSettings({ historyEnabled: !getSettings().historyEnabled });
      renderHistory();
    });
    $("hist-clear").addEventListener("click", (e) => {
      const btn = e.currentTarget;
      if (!clearArmed) {
        clearArmed = true;
        btn.textContent = "Sure?";
        setTimeout(() => {
          clearArmed = false;
          btn.textContent = "Clear all";
        }, 3000);
        return;
      }
      clearArmed = false;
      btn.textContent = "Clear all";
      localStorage.setItem("snipziHistory", "[]");
      renderHistory();
    });

    $("imgbay-login").addEventListener("click", () => {
      try {
        const base = fpsImgbayBase(getSettings().imgbayUrl);
        invoke("imgbay_login", { url: base }).catch((e) => toast(msgOf(e)));
      } catch (e) {
        toast(msgOf(e));
      }
    });
    $("imgbay-check").addEventListener("click", async () => {
      $("imgbay-msg").textContent = "Checking...";
      try {
        $("imgbay-msg").textContent = await fpsImgbayCheck(getSettings().imgbayUrl);
      } catch (e) {
        $("imgbay-msg").textContent = msgOf(e);
      }
    });

    initSettingsForm();
    renderLast();
    renderHistory();

    listen("capture:region", (e) => handleRegion(e.payload));
    listen("capture:screen", (e) => handleScreen(e.payload || {}));
    listen("popup:action", (e) => {
      const a = e.payload;
      if (a === "copy") $("last-copy").click();
      else if (a === "upload") $("last-upload").click();
      else if (a === "open") $("last-open").click();
      else if (a === "folder") $("last-folder").click();
    });

    // Re-register the user's own shortcuts (Rust starts with the defaults).
    applyHotkeys(true);
  }

  init();
})();
