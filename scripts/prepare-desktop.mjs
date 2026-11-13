import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopPlaceholder } from "../src/desktop-launcher.mjs";

// A private installation keeps the live redirect (and its credential) out of
// source control and npm packages, while importing the current source backend.
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = join(root, ".local", "desktop-plugin");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
// A distinct name also gives Magpie a distinct frame key. Reusing the source
// package's name can revive its cached broken frame after replacing installs.
const name = `${manifest.name}-desktop`;
await mkdir(join(directory, "page"), { recursive: true, mode: 0o700 });
for (const file of ["icon.svg", "icon.png", "icon-dark.png"]) await copyFile(join(root, "page", file), join(directory, "page", file));
await writeFile(join(directory, "package.json"), JSON.stringify({
  name, version: manifest.version, description: manifest.description,
  type: "module", main: "./index.mjs", magpie: manifest.magpie,
}, null, 2) + "\n");
const source = new URL("../src/plugin.mjs", import.meta.url).href;
await writeFile(join(directory, "index.mjs"), `import { createPlugin } from ${JSON.stringify(source)};
import { fileURLToPath } from "node:url";
export default { id: ${JSON.stringify(name)}, server: (input, options) => createPlugin(input, options, {
  launcherFile: fileURLToPath(new URL("./page/index.html", import.meta.url)),
}) };
`);
try { await writeFile(join(directory, "page", "index.html"), desktopPlaceholder, { flag: "wx", mode: 0o600 }); }
catch (error) { if (error.code !== "EEXIST") throw error; }
console.log(`桌面兼容入口已准备：${directory}`);
console.log(`安装命令：magpie plugin add "${directory}"`);
