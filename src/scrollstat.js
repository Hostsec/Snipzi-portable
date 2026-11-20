(function () {
  const { invoke } = window.__TAURI__.core;
  const t = document.getElementById("t");
  async function tick() {
    try {
      const px = await invoke("get_scroll_status");
      t.textContent = "Scrolling capture... " + Number(px).toLocaleString("en-US") + " px";
    } catch (e) {}
  }
  tick();
  setInterval(tick, 200);
})();
