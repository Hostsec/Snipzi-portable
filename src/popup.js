// popup.js: the small optional card that appears after a capture. All actions go to the main window.
(function () {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const $ = (id) => document.getElementById(id);
  let timer = null, remaining = 0, total = 0, paused = false, last = 0;

  function close() { clearInterval(timer); invoke("close_popup").catch(() => {}); }

  function startTimer(secs) {
    clearInterval(timer);
    total = remaining = Math.max(0, Number(secs) || 0) * 1000;
    $("fill").style.width = total ? "100%" : "0";
    if (!total) return;
    last = Date.now();
    timer = setInterval(() => {
      const now = Date.now();
      if (!paused) remaining -= now - last;
      last = now;
      $("fill").style.width = Math.max(0, remaining / total * 100) + "%";
      if (remaining <= 0) close();
    }, 100);
  }

  async function load() {
    const p = await invoke("get_popup").catch(() => null);
    if (!p) return;
    $("img").src = p.thumb || "";
    $("name").textContent = p.name || "";
    $("meta").textContent = p.meta || "";
    $("msg").textContent = p.msg || "";
    $("open").disabled = $("folder").disabled = !p.path;
    $("upload").style.display = p.canUpload ? "" : "none";
    startTimer(p.seconds);
  }

  ["copy", "upload", "open", "folder"].forEach((a) => {
    $(a).addEventListener("click", async () => {
      await invoke("popup_action", { action: a }).catch(() => {});
      if (a === "copy") { $("msg").textContent = "Copied"; startTimer(3); }
      else if (a === "upload") { $("msg").textContent = "Uploading..."; startTimer(8); }
      else close();
    });
  });
  $("x").addEventListener("click", close);
  document.addEventListener("mouseenter", () => (paused = true));
  document.addEventListener("mouseleave", () => (paused = false));
  listen("popup:update", load);
  load();
})();
