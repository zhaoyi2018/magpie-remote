(() => {
  const paint = (theme) => {
    document.documentElement.dataset.theme = theme.dark ? "dark" : "light";
    for (const [key, value] of Object.entries(theme.tokens ?? {})) {
      if (typeof value === "string") document.documentElement.style.setProperty(`--magpie-${key}`, value);
    }
  };
  paint({ dark: matchMedia("(prefers-color-scheme: dark)").matches });
  addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.magpie !== 1) return;
    const message = event.data;
    if (message.event === "theme") paint(message.data);
    else if (message.id === "migpie-remote-theme" && message.result) paint(message.result);
  });
  if (parent !== window) parent.postMessage({ magpie: 1, id: "migpie-remote-theme", method: "hello" }, "*");
})();
