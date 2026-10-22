import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
async function walk(directory) {
  const items = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const item of items) {
    if (["node_modules", ".git", ".local", ".sandbox"].includes(item.name)) continue;
    const path = resolve(directory, item.name);
    if (item.isDirectory()) result.push(...await walk(path));
    else result.push(path);
  }
  return result;
}

const files = await walk(root);
for (const file of files.filter((file) => file.endsWith(".mjs"))) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
let links = 0;
for (const file of files.filter((file) => file.endsWith(".md"))) {
  const contents = await readFile(file, "utf8");
  for (const match of contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    await readFile(resolve(dirname(file), target.split("#")[0]));
    links++;
  }
}
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const entry = await import(new URL(manifest.main, new URL("../", import.meta.url)));
assert.deepEqual(Object.keys(entry), ["default"]);
assert.equal(entry.default.id, manifest.name);
assert.equal(typeof entry.default.server, "function");
console.log(`Checked JavaScript syntax, plugin entry and ${links} local documentation links.`);
