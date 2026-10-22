(() => {
  const status = document.getElementById("launch-status");
  const retry = document.getElementById("launch-retry");
  let loading = false;
  async function discover() {
    if (loading) return;
    loading = true;
    retry.hidden = true;
    document.getElementById("launch-help").hidden = true;
    status.textContent = "正在打开连接管理…";
    for (let attempt = 0; attempt < 20; attempt++) {
      const endpoint = await new Promise((resolve) => {
        window.__migpieRemoteEndpoint = undefined;
        const script = document.createElement("script");
        script.src = `.runtime/endpoint.js?t=${Date.now()}`;
        const finish = () => { script.remove(); resolve(window.__migpieRemoteEndpoint); };
        script.onload = finish;
        script.onerror = finish;
        document.head.append(script);
      });
      if (endpoint?.url) {
        try {
          const target = new URL(endpoint.url);
          if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !/^\/[A-Za-z0-9_-]{43}\/$/.test(target.pathname)) throw new Error("无效的管理地址");
          target.hash = new URLSearchParams({ launcher: location.href }).toString();
          location.replace(target.href);
          return;
        } catch { status.textContent = "管理服务地址无效，请重新加载插件。"; break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    loading = false;
    status.textContent = "管理服务尚未就绪";
    retry.hidden = false;
    document.getElementById("launch-help").hidden = false;
  }
  retry.addEventListener("click", discover);
  // Say hello before navigating this same sandboxed frame to our local service.
  // The service has its own authenticated API; it does not call Magpie's API.
  Promise.resolve(window.magpie?.ready).then(discover).catch((error) => {
    status.textContent = error.message;
    retry.hidden = false;
  });
})();
