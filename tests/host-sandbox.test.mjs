import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHostSandbox } from "../scripts/host-sandbox.mjs";
import { startUIHarness } from "../scripts/ui-harness.mjs";
import { publishEndpoint } from "../src/web-server.mjs";

test("host sandbox isolates runtime endpoints and preserves source files and dependencies after cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "migpie-host-sandbox-test-"));
  const source = join(directory, "source");
  const modules = fileURLToPath(new URL("../node_modules/", import.meta.url));
  const dependencyFile = join(modules, "ssh2", "package.json");
  const dependencyBytes = await readFile(dependencyFile);
  let sandbox;
  let harness;
  let unpublish;
  t.after(async () => {
    await harness?.close();
    unpublish?.();
    await sandbox?.cleanup();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(join(source, "page", ".runtime"), { recursive: true });
  const files = new Map([
    ["index.mjs", 'export { default } from "./src/plugin.mjs";\n'],
    [join("src", "plugin.mjs"), 'import ssh2 from "ssh2";\nexport default { Client: ssh2.Client };\n'],
    [join("page", "manage.html"), "<p>Isolated page fixture</p>\n"],
    ["package.json", '{"name":"host-sandbox-fixture","type":"module","dependencies":{"ssh2":"1.17.0"}}\n'],
  ]);
  for (const [file, contents] of files) await writeFile(join(source, file), contents);
  await symlink(await realpath(modules), join(source, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const sourceEndpoint = join(source, "page", ".runtime", "endpoint.js");
  const marker = Buffer.from('﻿window.__migpieRemoteEndpoint = {"url":"http://127.0.0.1:1/source-only/"};\r\n');
  await writeFile(sourceEndpoint, marker);
  await writeFile(join(source, "page", ".runtime", "stale.tmp"), "source runtime must be excluded");

  sandbox = await createHostSandbox(source);
  assert.notEqual(await realpath(sandbox.root), await realpath(source));
  for (const file of files.keys()) assert.deepEqual(await readFile(join(sandbox.root, file)), await readFile(join(source, file)));
  await assert.rejects(lstat(join(sandbox.root, "page", ".runtime")), { code: "ENOENT" });
  assert.throws(() => sandbox.getEndpoint(), { code: "ENOENT" });
  const requireFromCopy = createRequire(pathToFileURL(join(sandbox.root, "index.mjs")));
  assert.equal(requireFromCopy.resolve("ssh2"), createRequire(import.meta.url).resolve("ssh2"));
  const { default: plugin } = await import(pathToFileURL(join(sandbox.root, "index.mjs")));
  assert.equal(typeof plugin.Client, "function", "Copied runtime code must load its installed dependencies");

  const endpoint = join(sandbox.root, "page", ".runtime", "endpoint.js");
  const url = "http://127.0.0.1:12345/isolated-host/";
  unpublish = await publishEndpoint(endpoint, url);
  assert.equal(sandbox.getEndpoint(), url);
  assert.deepEqual(await readFile(sourceEndpoint), marker);
  harness = await startUIHarness({ getEndpoint: sandbox.getEndpoint });
  const response = await fetch(new URL("_magpie/plugin/ui-test/.runtime/endpoint.js", harness.url), { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), `window.__migpieRemoteEndpoint = ${JSON.stringify({ url })};`);
  await harness.close();
  harness = undefined;
  unpublish();
  unpublish = undefined;
  await assert.rejects(readFile(endpoint), { code: "ENOENT" });
  assert.deepEqual(await readFile(sourceEndpoint), marker);

  await sandbox.cleanup();
  await assert.rejects(lstat(sandbox.directory), { code: "ENOENT" });
  assert.deepEqual(await readFile(sourceEndpoint), marker);
  assert.equal(await realpath(join(source, "node_modules")), await realpath(modules));
  assert.deepEqual(await readFile(dependencyFile), dependencyBytes);
  for (const file of files.keys()) assert.deepEqual(await readFile(join(source, file)), Buffer.from(files.get(file)));
});
