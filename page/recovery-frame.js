(() => {
  const sourceOrigin = location.origin;
  let pending = false;
  addEventListener("message", async (event) => {
    const request = event.data?.request;
    if (event.source !== parent || event.data?.type !== "migpie-recovery-challenge" || !/^[A-Za-z0-9_-]{43}$/.test(request ?? "")) return;
    try {
      const response = await fetch(new URL(`/recovery/identity/${request}`, sourceOrigin), { credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(3000) });
      if (response.ok) parent.postMessage({ type: "migpie-recovery-ready", request, result: await response.json() }, "*");
    } catch { /* A failed challenge leaves automatic recovery disabled. */ }
  });
  addEventListener("message", (event) => {
    const request = event.data?.request, launcher = event.data?.launcher;
    if (pending || event.source !== parent || event.data?.type !== "migpie-recovery-discover" || !/^[A-Za-z0-9_-]{32}$/.test(request ?? "")) return;
    let url;
    try {
      url = new URL(launcher);
      const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      if (url.protocol !== "http:" || (!local && url.origin !== "http://wails.localhost") || url.username || url.password
        || !/^\/_magpie\/plugin\/[a-zA-Z0-9_-]+\/(?:index\.html)?$/.test(url.pathname)) return;
    } catch { return; }
    pending = true;
    const stylesheet = new URL(".runtime/discovery.css?t=" + Date.now(), url);
    if (!document.querySelector("meta[data-discovery-policy]")) {
      const policy = document.createElement("meta");
      policy.httpEquiv = "Content-Security-Policy";
      policy.dataset.discoveryPolicy = "true";
      policy.content = `default-src 'none'; style-src ${stylesheet.origin}${stylesheet.pathname}; connect-src ${sourceOrigin}; object-src 'none'; base-uri 'none'; form-action 'none'`;
      document.head.append(policy);
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.referrerPolicy = "no-referrer";
    link.href = stylesheet.href;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true; pending = false; clearTimeout(timer);
      const port = getComputedStyle(document.documentElement).getPropertyValue("--migpie-management-port").trim();
      link.remove();
      if (/^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65535) {
        parent.postMessage({ type: "migpie-recovery-candidate", request, origin: `http://127.0.0.1:${port}` }, "*");
      }
    };
    const timer = setTimeout(finish, 3000);
    link.onload = finish;
    link.onerror = finish;
    document.head.append(link);
  });
})();
