import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { desktopPlaceholder, publishDesktopLauncher } from "../src/desktop-launcher.mjs";
import { createHostSandbox } from "../scripts/host-sandbox.mjs";
import { temporary } from "./helpers.mjs";

const endpoint = "http://127.0.0.1:12345/" + "a".repeat(43) + "/";

test("native launchers navigate directly, retain a discoverable entry on shutdown and preserve newer owners", async (t) => {
  const file = join(await temporary(t), "page", "index.html");
  const first = await publishDesktopLauncher(file, endpoint);
  t.after(first);
  const html = await readFile(file, "utf8");
  assert.ok(html.includes(`content="0;url=${endpoint}"`));
  assert.doesNotMatch(html, /<script|<link|<img|\.runtime\//);
  const second = await publishDesktopLauncher(file, endpoint);
  t.after(second);
  first();
  assert.notEqual(await readFile(file, "utf8"), desktopPlaceholder);
  second();
  assert.equal(await readFile(file, "utf8"), desktopPlaceholder);
  const third = await publishDesktopLauncher(file, endpoint);
  await writeFile(file, "newer entry");
  third();
  assert.equal(await readFile(file, "utf8"), "newer entry");
});

test("native entry publication refuses external URLs and HTML injection without replacing the current entry", async (t) => {
  const file = join(await temporary(t), "index.html");
  await writeFile(file, "existing entry");
  for (const value of ["https://example.com/", endpoint + "?x=1", endpoint + "#fragment", endpoint.replace("127.0.0.1", "localhost"), endpoint.replace("a".repeat(43), 'x\"><script>'), endpoint.replace(":12345/", ":0/")]) {
    await assert.rejects(publishDesktopLauncher(file, value), /无效的桌面管理地址/);
    assert.equal(await readFile(file, "utf8"), "existing entry");
  }
});

test("a real plugin restart publishes its new authenticated endpoint and removes the stopped host credential", async (t) => {
  const directory = await temporary(t);
  const sandbox = await createHostSandbox(fileURLToPath(new URL("../", import.meta.url)));
  t.after(() => sandbox.cleanup());
  const { createPlugin, closePlugin } = await import(pathToFileURL(join(sandbox.root, "src", "plugin.mjs")));
  const launcherFile = join(directory, "native", "page", "index.html");
  const endpoints = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const hooks = await createPlugin({ directory }, undefined, { launcherFile });
    t.after(() => closePlugin(hooks));
    const url = sandbox.getEndpoint();
    endpoints.push(url);
    assert.ok((await readFile(launcherFile, "utf8")).includes(url));
    const response = await fetch(new URL("api/snapshot", url), { headers: { Authorization: "Bearer " + new URL(url).pathname.split("/")[1] } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).connections, []);
    await closePlugin(hooks);
    assert.equal(await readFile(launcherFile, "utf8"), desktopPlaceholder);
  }
  assert.notEqual(endpoints[0], endpoints[1]);
});
