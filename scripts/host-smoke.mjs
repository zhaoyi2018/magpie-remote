import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { echoServer, exchange, sshServer, until } from "../tests/helpers.mjs";
import { startUIHarness } from "./ui-harness.mjs";

const [bunPath, hostPath] = process.argv.slice(2);
assert.ok(bunPath && hostPath, "Usage: node scripts/host-smoke.mjs <bun executable> <Magpie host.js>");
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "migpie-host-smoke-"));
const cleanup = [];
const context = { after(fn) { cleanup.unshift(fn); } };
let child;
try {
  const fixture = await sshServer(context);
  const echo = await echoServer(context);
  child = spawn(resolve(bunPath), [resolve(hostPath)], {
    cwd: directory, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: directory, USERPROFILE: directory,
      XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"),
      MIGPIE_TEST_PASSWORD: "local-test-secret",
    },
  });
  const pending = new Map();
  let sequence = 0;
  let diagnostics = "";
  child.stderr.on("data", (data) => { diagnostics = (diagnostics + data).slice(-4000); });
  const fail = (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code) => fail(new Error(`Plugin host exited (${code}): ${diagnostics}`)));
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${diagnostics}`)); }, 10000);
    pending.set(id, {
      resolve(result) { clearTimeout(timer); resolve(result); },
      reject(error) { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const loaded = await rpc("init", {
    authPath: join(directory, "plugin-auth.json"), directory,
    plugins: [{ spec: root, target: root }],
  });
  assert.equal(loaded.plugins.length, 1);
  assert.equal(loaded.plugins[0].error, undefined, loaded.plugins[0].error);
  assert.equal(loaded.plugins[0].tools.length, 16);
  const call = async (name, args = {}) => JSON.parse((await rpc("tool", { spec: root, name, args, ms: 5000 })).text);
  await call("save_connection", { connection: { ...fixture.profile, autoReconnect: true } });
  assert.equal((await call("connect", { connectionId: fixture.profile.id })).state, "connected");
  for (const direction of ["c2s", "s2c"]) {
    const forward = await call("forward_add", {
      connectionId: fixture.profile.id,
      forward: { id: direction, direction, bindPort: 0, targetPort: echo.port },
    });
    const payload = Buffer.from(`Actual Magpie host: ${direction}`);
    assert.deepEqual(await exchange(forward.bindPort, payload), payload);
    await call("forward_remove", { connectionId: fixture.profile.id, forwardId: direction });
    await assert.rejects(exchange(forward.bindPort), /ECONNREFUSED/);
  }
  for (const direction of ["c2s", "s2c"]) await call("forward_add", {
    connectionId: fixture.profile.id, forward: { id: direction, direction, bindPort: 0, targetPort: echo.port },
  });
  const before = await call("status", { connectionId: fixture.profile.id });
  for (const client of fixture.clients) client.end();
  await until(async () => {
    const status = await call("status", { connectionId: fixture.profile.id });
    return status.state === "connected" && status.reconnect.state === "idle" && status.connectedAt !== before.connectedAt;
  }, "Actual host did not reconnect");
  const recovered = await call("status", { connectionId: fixture.profile.id });
  assert.equal(recovered.forwards.length, 2);
  for (const forward of recovered.forwards) assert.ok((await exchange(forward.bindPort)).length);
  const backup = await call("config_backup");
  assert.ok((await call("config_backups")).some((item) => item.id === backup.id));
  const preview = await call("config_restore_preview", { backupId: backup.id });
  await call("config_restore", { backupId: backup.id, revision: preview.revision, stopConnections: true });
  assert.equal((await call("status", { connectionId: fixture.profile.id })).reconnect.state, "stopped");
  for (const forward of recovered.forwards) await assert.rejects(exchange(forward.bindPort), /ECONNREFUSED/);
  await call("remove_connection", { connectionId: fixture.profile.id });
  assert.deepEqual(await call("connections"), []);
  console.log("Magpie host: 16 tools registered; SSH authentication, c2s/s2c recovery and data round trips, backup/restore, retry cancellation, port release and profile removal passed.");
  if (process.argv.includes("--ui")) {
    const harness = await startUIHarness();
    cleanup.unshift(() => harness.close());
    console.log(JSON.stringify({ uiURL: harness.url, ssh: fixture.profile, testPassword: "local-test-secret", targetPort: echo.port }));
    console.log("UI test is ready. Send check to verify active forwards, or close to finish.");
    await new Promise((resolve) => {
      const control = createInterface({ input: process.stdin });
      control.on("line", (line) => {
        if (line.trim() === "close") { control.close(); resolve(); }
        if (line.trim() === "check") {
          void (async () => {
            const connections = await call("connections");
            const results = [];
            for (const row of connections) for (const forward of row.session.forwards) {
              const payload = Buffer.from(`UI ${forward.direction} round trip`);
              assert.deepEqual(await exchange(forward.bindPort, payload), payload);
              results.push({ connection: row.connection.id, direction: forward.direction, port: forward.bindPort, passed: true });
            }
            console.log(JSON.stringify({ uiDataVerification: results }));
          })().catch((error) => console.error(error.message));
        }
      });
      control.once("close", resolve);
    });
  }
} finally {
  if (child && child.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
  for (const fn of cleanup) await fn();
  const absolute = resolve(directory);
  assert.equal(dirname(absolute), resolve(tmpdir()));
  assert.ok(basename(absolute).startsWith("migpie-host-smoke-"));
  await rm(absolute, { recursive: true, force: true });
}
