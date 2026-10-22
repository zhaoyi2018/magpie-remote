const namespace = "http://www.w3.org/2000/svg";
const definitions = {
  server: { paths: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", "M3 9h18M3 15h18M7 6h.01M7 12h.01M7 18h.01"] },
  laptop: { paths: ["M5.5 3h13A1.5 1.5 0 0 1 20 4.5V17H4V4.5A1.5 1.5 0 0 1 5.5 3Z", "M2 20h20M4 17l-2 3m18-3 2 3"] },
  target: { paths: ["M6 3h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", "M6 14h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2Z", "M8 6.5h3M8 17.5h3"] },
  arrow: { viewBox: "0 0 32 24", strokeWidth: 1.5, paths: ["M2 12h28m-6-6 6 6-6 6"] },
  plus: { paths: ["M12 5v14M5 12h14"] },
  upload: { paths: ["M12 16V3m-4 4 4-4 4 4M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"] },
  search: { paths: ["M21 21l-5-5", "M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z"] },
  refresh: { paths: ["M20 7v5h-5M4 17v-5h5", "M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17"] },
  disconnect: { paths: ["M9 4H5v16h4M10 12h11m-4-4 4 4-4 4"] },
  close: { paths: ["M6 6l12 12M6 18 18 6"] },
  more: { strokeWidth: 3, paths: ["M12 4h.01M12 12h.01M12 20h.01"] },
  info: { paths: ["M12 11v6M12 7h.01", "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z"] },
  shield: { paths: ["m12 3 8 3v5c0 5-8 10-8 10S4 16 4 11V6l8-3Z", "m8 12 3 3 5-6"] },
  edit: { paths: ["m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5"] },
  trash: { paths: ["M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"] },
  forward: { paths: ["M3 7h17m-4-4 4 4-4 4M21 17H4m4-4-4 4 4 4"] },
  chevron: { paths: ["m6 9 6 6 6-6"] },
  settings: { paths: ["M4 7h16M4 17h16M9 4v6M15 14v6"] },
  logs: { paths: ["M8 3h10a2 2 0 0 1 2 2v16H6a2 2 0 0 1-2-2V7h4V3Z", "M8 7v12M12 8h4M12 12h4M12 16h4"] },
};

export function icon(name) {
  if (!Object.hasOwn(definitions, name)) throw new Error(`未知图标：${name}`);
  const definition = definitions[name];
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", definition.viewBox ?? "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  for (const d of definition.paths) {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", d);
    if (definition.strokeWidth) path.setAttribute("stroke-width", definition.strokeWidth);
    svg.append(path);
  }
  return svg;
}

export function setIcon(container, name) {
  container.replaceChildren(icon(name));
  container.dataset.icon = name;
}

export function renderIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((container) => setIcon(container, container.dataset.icon));
}
