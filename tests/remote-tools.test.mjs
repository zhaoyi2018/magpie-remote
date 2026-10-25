import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTools } from "../src/plugin.mjs";
import { OperationError } from "../src/errors.mjs";
import { RemoteManager } from "../src/remote.mjs";
import { ProfileStore, profileRevision, publicProfile } from "../src/store.mjs";
import { temporary } from "./helpers.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("configuration restore waits for an accepted remote submission and refuses to disconnect its session", async () => {
  const entered = deferred(), release = deferred();
  let busy = false, disconnected = 0, restored = 0;
  const remote = {
    async apply() { entered.resolve(); await release.promise; busy = true; return { state: "running" }; },
    async assertAllIdle() { if (busy) throw new OperationError("REMOTE_BUSY", "remote operation pending"); },
  };
  const store = { async previewRestore() { return { revision: "a".repeat(64) }; }, async restore() { restored++; } };
  const sessions = { async disconnectAll() { disconnected++; } };
  const tools = createTools(store, sessions, remote);
  const submitted = tools.remote_apply.execute({ connectionId: "server", action: "restart", revision: "b".repeat(64) });
  await entered.promise;
  const restoring = tools.config_restore.execute({ backupId: "fixture", revision: "a".repeat(64), stopConnections: true });
  const refused = assert.rejects(restoring, { code: "REMOTE_BUSY" });
  release.resolve();
  assert.equal((await submitted).state, "running");
  await refused;
  assert.equal(disconnected, 0);
  assert.equal(restored, 0);
});

test("remote cache cleanup failure reports that the connection deletion has already committed", async () => {
  let removed = false, forgotten = false;
  const store = { async remove() { removed = true; return { removed: true }; } };
  const sessions = { isActive: () => false, async forgetConnection() { forgotten = true; } };
  const remote = { async assertIdle() {}, async forget() { throw new Error("fixture write failed"); } };
  const tools = createTools(store, sessions, remote);
  await assert.rejects(tools.remove_connection.execute({ connectionId: "server", expectedRevision: "a".repeat(64) }), (error) => {
    assert.equal(error.code, "REMOTE_CLEANUP_FAILED");
    assert.match(error.message, /已删除/);
    return true;
  });
  assert.equal(removed, true); assert.equal(forgotten, true);
});

test("persisted unknown operations block deletion and global restore while permitting same-server credential repair", async (t) => {
  const directory = await temporary(t), store = new ProfileStore(join(directory, "connections.json"));
  const profile = await store.save({ id: "server", host: "fixture.invalid", username: "tester", passwordEnv: "OLD_PASSWORD" });
  const backup = await store.createBackup();
  const file = store.file + ".remote.json";
  const binding = createHash("sha256").update(JSON.stringify([profile.id, profile.host, profile.port, profile.username])).digest("hex");
  await writeFile(file, JSON.stringify({ version: 1, records: [{ connectionId: profile.id, binding, operation: {
    id: "79e2990d-4a82-45e5-951d-1d1a581ff756", action: "update", revision: "a".repeat(64), state: "running", step: "executing",
    message: "fixture pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } }] }));
  let forgotten = 0, disconnected = 0;
  const sessions = { isActive: () => false, status: (id) => id ? { state: "disconnected" } : [],
    async forgetConnection() { forgotten++; }, async disconnectAll() { disconnected++; } };
  const remote = new RemoteManager({ store, sessions });
  t.after(() => remote.close());
  const tools = createTools(store, sessions, remote);
  assert.equal((await tools.remote_operation.execute({ connectionId: profile.id })).state, "unknown");
  await assert.rejects(tools.remove_connection.execute({ connectionId: profile.id, expectedRevision: profileRevision(profile) }), { code: "REMOTE_BUSY" });
  const preview = await tools.config_restore_preview.execute({ backupId: backup.id });
  await assert.rejects(tools.config_restore.execute({ backupId: backup.id, revision: preview.revision, stopConnections: true }), { code: "REMOTE_BUSY" });
  assert.equal(forgotten, 0); assert.equal(disconnected, 0);
  const saved = await tools.save_connection.execute({ connection: { ...publicProfile(profile), passwordEnv: "RECOVERED_PASSWORD" }, expectedRevision: profileRevision(profile) });
  assert.equal(saved.connection.passwordEnv, "RECOVERED_PASSWORD");
  await assert.rejects(tools.save_connection.execute({ connection: { ...saved.connection, host: "different.invalid" }, expectedRevision: saved.revision }), { code: "REMOTE_BUSY" });
  assert.equal((await store.get(profile.id)).host, profile.host);
});
