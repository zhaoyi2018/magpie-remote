(() => {
  const systemTheme = matchMedia("(prefers-color-scheme: dark)");
  let followsSystem = true;
  const paint = (theme) => {
    document.documentElement.dataset.theme = theme.dark ? "dark" : "light";
    const icon = document.querySelector('link[rel="icon"]');
    const source = theme.dark ? "icon-dark.png" : "icon.png";
    if (icon && icon.getAttribute("href") !== source) icon.setAttribute("href", source);
    for (const [key, value] of Object.entries(theme.tokens ?? {})) {
      if (typeof value === "string") document.documentElement.style.setProperty(`--magpie-${key}`, value);
    }
  };
  paint({ dark: systemTheme.matches });
  systemTheme.addEventListener("change", (event) => {
    if (followsSystem) paint({ dark: event.matches });
  });
  addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.magpie !== 1) return;
    const message = event.data;
    if (message.event === "theme") { followsSystem = false; paint(message.data); }
    else if (message.id === "migpie-remote-theme" && message.result) { followsSystem = false; paint(message.result); }
  });
  if (parent !== window) parent.postMessage({ magpie: 1, id: "migpie-remote-theme", method: "hello" }, "*");
})();
