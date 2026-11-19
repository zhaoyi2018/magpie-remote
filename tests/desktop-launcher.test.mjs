import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { desktopPlaceholder, publishDesktopLauncher } from "../src/desktop-launcher.mjs";
import { createHostSandbox } from "../scripts/host-sandbox.mjs";
import { temporary } from "./helpers.mjs";
import { loadRecoveryKey, startDesktopRecovery } from "../src/web-server.mjs";

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

test("desktop discovery preserves its port, requires proof and only signs the current management address", async (t) => {
  const directory = await temporary(t);
  const file = join(directory, "recovery-port");
  const recovery = await loadRecoveryKey(join(directory, "recovery-key"));
  const first = await startDesktopRecovery({ file, endpoint, recovery });
  await first.close();
  const replacement = endpoint.replace(":12345/", ":12346/");
  const service = await startDesktopRecovery({ file, endpoint: replacement, recovery });
  t.after(() => service.close());
  assert.equal(service.origin, first.origin);
  const challenge = randomBytes(32).toString("base64url");
  const proof = createHmac("sha256", Buffer.from(recovery.secret, "base64url")).update(service.origin + "\n" + challenge).digest("base64url");
  const path = service.origin + "/recovery/endpoint/";
  assert.equal((await fetch(path + "x".repeat(43) + "/" + challenge)).status, 404);
  assert.equal((await fetch(path + proof + "/" + challenge, { headers: { Origin: "https://unrelated.example" } })).status, 403);
  const response = await fetch(path + proof + "/" + challenge, { headers: { Origin: "null" } });
  assert.equal(response.status, 200);
  const { message, signature } = await response.json();
  const publicKey = createPublicKey({ key: Buffer.from(recovery.publicKey, "base64url"), type: "spki", format: "der" });
  assert.ok(verify("sha256", Buffer.from(message), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
  assert.deepEqual(JSON.parse(message), { version: 1, purpose: "endpoint", origin: service.origin, challenge, url: replacement });
});

test("the prepared desktop plugin publishes and clears its launcher outside Magpie's reload scan", async (t) => {
  const directory = await temporary(t);
  const sandbox = await createHostSandbox(fileURLToPath(new URL("../", import.meta.url)));
  t.after(() => sandbox.cleanup());
  const installation = join(sandbox.root, ".local", "desktop-plugin");
  const legacy = join(installation, "page", "index.html");
  await mkdir(join(installation, "page"), { recursive: true });
  await writeFile(legacy, desktopPlaceholder);
  await mkdir(join(sandbox.root, "scripts"));
  const prepare = join(sandbox.root, "scripts", "prepare-desktop.mjs");
  await copyFile(new URL("../scripts/prepare-desktop.mjs", import.meta.url), prepare);
  await promisify(execFile)(process.execPath, [prepare]);

  const manifestFile = join(installation, "package.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  assert.equal(manifest.magpie.page.file, ".runtime/index.html");
  assert.equal(manifest.magpie.page.icon, ".runtime/icon.svg");
  const launcherFile = join(installation, manifest.magpie.page.file);
  assert.equal(await readFile(launcherFile, "utf8"), desktopPlaceholder);
  assert.deepEqual(await readFile(join(installation, manifest.magpie.page.icon)), await readFile(join(sandbox.root, "page", "icon.svg")));

  const entry = join(installation, manifest.main);
  const { default: plugin } = await import(pathToFileURL(entry));
  const { closePlugin } = await import(pathToFileURL(join(sandbox.root, "src", "plugin.mjs")));
  const watchedFiles = [manifestFile, entry, legacy];
  const watchStamp = () => Promise.all(watchedFiles.map(async (file) => {
    const { mtimeNs, size } = await stat(file, { bigint: true });
    return [mtimeNs, size];
  }));
  const initialStamp = await watchStamp();
  const endpoints = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const hooks = await plugin.server({ directory });
    try {
      const url = sandbox.getEndpoint();
      endpoints.push(url);
      assert.ok((await readFile(launcherFile, "utf8")).includes(url));
      assert.deepEqual(await watchStamp(), initialStamp);
      const response = await fetch(new URL("api/snapshot", url), { headers: { Authorization: "Bearer " + new URL(url).pathname.split("/")[1] } });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).connections, []);
    } finally {
      await closePlugin(hooks);
    }
    assert.equal(await readFile(launcherFile, "utf8"), desktopPlaceholder);
    assert.deepEqual(await watchStamp(), initialStamp);
  }
  assert.notEqual(endpoints[0], endpoints[1]);
});
