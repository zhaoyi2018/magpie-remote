import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ProfileStore } from "../src/store.mjs";
import { SessionManager } from "../src/sessions.mjs";
import { createTools } from "../src/plugin.mjs";
import { echoServer, exchange, sshServer, temporary, until } from "./helpers.mjs";

const profile = { id: "shared", host: "host.example", username: "dev" };
async function setup(t, options = {}) {
  const store = new ProfileStore(join(await temporary(t), "connections.json"));
  const sessions = new SessionManager(options);
  t.after(() => sessions.close());
  return { store, sessions, tools: createTools(store, sessions) };
}
async function row(tools, id = profile.id) {
  return (await tools.connections.execute()).find((item) => item.connection.id === id);
}

test("stale and unversioned updates cannot overwrite a newer connection or rotate its backups", async (t) => {
  const { store, tools } = await setup(t);
  await tools.save_connection.execute({ connection: profile, expectedRevision: null });
  const first = await row(tools);
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  await tools.save_connection.execute({ connection: { ...first.connection, name: "Changed by A" }, expectedRevision: first.revision });
  const before = await readFile(store.file), backups = await store.listBackups();
  await assert.rejects(tools.save_connection.execute({ connection: { ...first.connection, host: "changed-by-b.example" }, expectedRevision: first.revision }), { code: "CONFIG_CONFLICT" });
  await assert.rejects(tools.save_connection.execute({ connection: first.connection }), { code: "CONFIG_REVISION_REQUIRED" });
  await assert.rejects(tools.save_connection.execute({ connection: first.connection, expectedRevision: null }), { code: "CONFIG_CONFLICT" });
  await assert.rejects(tools.save_connection.execute({ connection: first.connection, expectedRevision: "invalid" }), { code: "CONFIG_REVISION_INVALID" });
  assert.deepEqual(await readFile(store.file), before);
  assert.deepEqual(await store.listBackups(), backups);
  assert.equal((await row(tools)).connection.name, "Changed by A");
  assert.equal(JSON.parse(before).connections[0].revision, undefined);
});

test("queued edits conflict only for the same connection and no-op saves preserve its revision", async (t) => {
  const { tools } = await setup(t);
  await tools.save_connection.execute({ connection: profile });
  await tools.save_connection.execute({ connection: { ...profile, id: "other" } });
  const a = await row(tools), b = await row(tools, "other");
  const results = await Promise.allSettled(["A", "B"].map((name) => tools.save_connection.execute({ connection: { ...a.connection, name }, expectedRevision: a.revision })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "CONFIG_CONFLICT");
  const current = await row(tools);
  await Promise.all([
    tools.save_connection.execute({ connection: { ...current.connection, name: "Latest" }, expectedRevision: current.revision }),
    tools.save_connection.execute({ connection: { ...b.connection, name: "Independent" }, expectedRevision: b.revision }),
  ]);
  const unchanged = await row(tools);
  await tools.save_connection.execute({ connection: unchanged.connection, expectedRevision: unchanged.revision });
  assert.equal((await row(tools)).revision, unchanged.revision);
  assert.equal((await row(tools, "other")).connection.name, "Independent");
});

test("stale preset edits and deletions leave a live tunnel and its saved configuration intact", async (t) => {
  const fixture = await sshServer(t), echo = await echoServer(t);
  const { tools, store } = await setup(t, { env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  await tools.save_connection.execute({ connection: fixture.profile });
  const initial = await row(tools, fixture.profile.id);
  const forward = { id: "kept", direction: "c2s", bindPort: 0, targetPort: echo.port };
  await tools.forward_save.execute({ connectionId: fixture.profile.id, forward, expectedRevision: initial.revision });
  await tools.connect.execute({ connectionId: fixture.profile.id });
  const current = await row(tools, fixture.profile.id), port = current.session.forwards[0].bindPort;
  await assert.rejects(tools.forward_delete.execute({ connectionId: fixture.profile.id, forwardId: forward.id, expectedRevision: initial.revision }), { code: "CONFIG_CONFLICT" });
  await assert.rejects(tools.forward_save.execute({ connectionId: fixture.profile.id, forward: { ...forward, id: "extra" }, expectedRevision: initial.revision }), { code: "CONFIG_CONFLICT" });
  assert.equal((await store.get(fixture.profile.id)).forwards.length, 1);
  assert.ok((await exchange(port)).length);
  await tools.disconnect.execute({ connectionId: fixture.profile.id });
  await assert.rejects(tools.remove_connection.execute({ connectionId: fixture.profile.id, expectedRevision: initial.revision }), { code: "CONFIG_CONFLICT" });
  await tools.remove_connection.execute({ connectionId: fixture.profile.id, expectedRevision: current.revision });
  await assert.rejects(tools.save_connection.execute({ connection: current.connection, expectedRevision: current.revision }), { code: "CONFIG_CONFLICT" });
  assert.deepEqual(await tools.status.execute(), []);
});

test("failed preset deletion preserves its running tunnels until configuration is committed", async (t) => {
  const fixture = await sshServer(t), echo = await echoServer(t);
  const { tools, store } = await setup(t, { env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  const forwards = ["c2s", "s2c"].map((direction) => ({ id: direction, direction, bindPort: 0, targetPort: echo.port }));
  await tools.save_connection.execute({ connection: { ...fixture.profile, forwards } });
  await tools.connect.execute({ connectionId: fixture.profile.id });
  const current = await row(tools, fixture.profile.id), before = await readFile(store.file);
  // Leave an unusable backup path after the first configuration has been saved.
  await writeFile(store.backupDirectory, "blocked");
  for (const forward of current.session.forwards) {
    await assert.rejects(tools.forward_delete.execute({ connectionId: fixture.profile.id, forwardId: forward.id, expectedRevision: current.revision }), { code: "CONFIG_BACKUP_FAILED" });
    assert.ok((await exchange(forward.bindPort)).length);
  }
  assert.deepEqual(await readFile(store.file), before);
  await rm(store.backupDirectory);
  for (const forward of current.session.forwards) {
    const latest = await row(tools, fixture.profile.id);
    await tools.forward_delete.execute({ connectionId: fixture.profile.id, forwardId: forward.id, expectedRevision: latest.revision });
    await assert.rejects(exchange(forward.bindPort), /ECONNREFUSED/);
  }
  assert.deepEqual((await store.get(fixture.profile.id)).forwards, []);
});

test("a committed preset deletion reports a subsequent runtime stop failure and forgets reconnect intent", async (t) => {
  const fixture = await sshServer(t), echo = await echoServer(t);
  const { tools, store, sessions } = await setup(t, { env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  const forward = { id: "partial", direction: "c2s", bindPort: 0, targetPort: echo.port };
  await tools.save_connection.execute({ connection: { ...fixture.profile, forwards: [forward], autoReconnect: true } });
  await tools.connect.execute({ connectionId: fixture.profile.id });
  const current = await row(tools, fixture.profile.id);
  const remove = sessions.removeForward.bind(sessions);
  sessions.removeForward = async () => { throw new Error("Stop request rejected"); };
  await assert.rejects(tools.forward_delete.execute({ connectionId: fixture.profile.id, forwardId: forward.id, expectedRevision: current.revision }), (error) => {
    assert.equal(error.code, "FORWARD_STOP_FAILED");
    assert.match(error.message, /预设已删除/);
    return true;
  });
  assert.deepEqual((await store.get(fixture.profile.id)).forwards, []);
  assert.ok((await exchange(current.session.forwards[0].bindPort)).length);
  sessions.removeForward = remove;
  for (const client of fixture.clients) client.end();
  await until(() => sessions.status(fixture.profile.id).state === "connected" && sessions.status(fixture.profile.id).connectedAt !== current.session.connectedAt);
  assert.deepEqual(sessions.status(fixture.profile.id).forwards, []);
});

test("deleting failed profiles releases their runtime records while preserving an independent session", async (t) => {
  const fixture = await sshServer(t), echo = await echoServer(t);
  const { tools, sessions } = await setup(t, { env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  await tools.save_connection.execute({ connection: fixture.profile });
  await tools.connect.execute({ connectionId: fixture.profile.id });
  const live = await tools.forward_add.execute({ connectionId: fixture.profile.id, forward: { id: "live", direction: "c2s", bindPort: 0, targetPort: echo.port } });
  for (let i = 0; i < 20; i++) {
    const connection = { ...fixture.profile, id: "deleted-" + i, passwordEnv: "MISSING_TEST_PASSWORD", autoReconnect: true };
    await tools.save_connection.execute({ connection });
    await assert.rejects(tools.connect.execute({ connectionId: connection.id }), { code: "CREDENTIALS_REQUIRED" });
    const saved = await row(tools, connection.id);
    assert.equal(saved.session.reconnect.state, "paused");
    await tools.remove_connection.execute({ connectionId: connection.id, expectedRevision: saved.revision });
    assert.equal(sessions.status().some((item) => item.id === connection.id), false);
  }
  assert.equal(sessions.status().length, 1);
  assert.ok((await exchange(live.bindPort)).length);
});

test("failed configuration deletion retains its runtime history until a successful deletion", async (t) => {
  const { tools, store, sessions } = await setup(t, { env: {} });
  await tools.save_connection.execute({ connection: { ...profile, authMethod: "environment" } });
  await assert.rejects(tools.connect.execute({ connectionId: profile.id }), { code: "CREDENTIALS_REQUIRED" });
  const saved = await row(tools);
  await writeFile(store.backupDirectory, "blocked");
  await assert.rejects(tools.remove_connection.execute({ connectionId: profile.id, expectedRevision: saved.revision }), { code: "CONFIG_BACKUP_FAILED" });
  assert.ok(sessions.status(profile.id).logs.length);
  assert.equal((await row(tools)).revision, saved.revision);
  await rm(store.backupDirectory);
  await tools.disconnect.execute({ connectionId: profile.id });
  assert.ok(sessions.status(profile.id).logs.length);
  await tools.remove_connection.execute({ connectionId: profile.id, expectedRevision: saved.revision });
  assert.deepEqual(sessions.status(), []);
  await tools.save_connection.execute({ connection: { ...profile, authMethod: "environment" } });
  assert.equal((await row(tools)).session.logs, undefined);
});
