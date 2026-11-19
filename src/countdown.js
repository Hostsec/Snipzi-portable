(function () {
  const { invoke } = window.__TAURI__.core;
  const n = document.getElementById("n");
  async function tick() {
    try { n.textContent = String(await invoke("get_countdown")); } catch (e) {}
  }
  tick();
  setInterval(tick, 150);
})();
