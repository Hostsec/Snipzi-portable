(function () {
  const { invoke } = window.__TAURI__.core;
  const $ = (id) => document.getElementById(id);
  async function tick() {
    try {
      const st = await invoke("get_scroll_status");
      const px = Number(st.px).toLocaleString("en-US");
      $("t").textContent = (st.manual ? "Recording... " : "Scrolling for you... ") + px + " px";
      $("box").classList.toggle("warn", !!st.lost);
      if (st.lost) $("s").textContent = "Scrolled too far or too fast. Scroll back up a little.";
      else if (st.manual) $("s").textContent = "Scroll with your mouse wheel. Press Enter or Done when finished.";
      else $("s").textContent = "Keep the mouse still. Esc or Done finishes early.";
    } catch (e) {}
  }
  $("done").addEventListener("click", () => invoke("finish_scroll").catch(() => {}));
  tick();
  setInterval(tick, 200);
})();
