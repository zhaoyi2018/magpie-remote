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
    let invalidEndpoint = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const endpoint = await new Promise((resolve) => {
        const script = document.createElement("script");
        script.src = `.runtime/endpoint.js?t=${Date.now()}`;
        let done = false, value;
        Object.defineProperty(window, "__migpieRemoteEndpoint", {
          configurable: true, get: () => value,
          set: (next) => { if (!done && document.currentScript === script) value = next; },
        });
        const finish = (timedOut = false) => {
          if (done) return;
          done = true; clearTimeout(timer); script.remove();
          if (!timedOut) delete window.__migpieRemoteEndpoint;
          resolve(timedOut ? { timedOut: true } : value);
        };
        const timer = setTimeout(() => finish(true), 3000);
        script.onload = () => finish();
        script.onerror = () => finish();
        document.head.append(script);
      });
      if (endpoint?.timedOut) break;
      if (endpoint?.url) {
        try {
          const target = new URL(endpoint.url);
          if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.username || target.password
            || target.search || target.hash || !/^\/[A-Za-z0-9_-]{43}\/$/.test(target.pathname)) throw new Error("无效的管理地址");
          const launcher = new URL(location.href);
          launcher.searchParams.delete("invalid");
          const parameters = new URLSearchParams({ launcher: launcher.href });
          if (/^[A-Za-z0-9_-]{43}$/.test(endpoint.recovery?.secret ?? "") && /^[A-Za-z0-9_-]+$/.test(endpoint.recovery?.publicKey ?? "")) {
            parameters.set("recovery", endpoint.recovery.secret);
            parameters.set("key", endpoint.recovery.publicKey);
          }
          target.hash = parameters.toString();
          location.replace(target.href);
          return;
        } catch { invalidEndpoint = true; break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    loading = false;
    status.textContent = invalidEndpoint ? "管理服务地址无效，请重新加载插件。" : "管理服务尚未就绪";
    retry.hidden = false;
    document.getElementById("launch-help").hidden = false;
  }
  retry.addEventListener("click", discover);
  // Say hello before navigating this same sandboxed frame to our local service.
  // A missing bridge response must not prevent service discovery indefinitely.
  Promise.race([Promise.resolve(window.magpie?.ready), new Promise((resolve) => setTimeout(resolve, 3000))]).then(discover).catch((error) => {
    status.textContent = error.message;
    retry.hidden = false;
  });
})();
