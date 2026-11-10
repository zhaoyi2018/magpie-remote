import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProfileStore, profileRevision } from "../src/store.mjs";
import { SessionManager } from "../src/sessions.mjs";
import { RemoteManager } from "../src/remote.mjs";
import { createTools } from "../src/plugin.mjs";
import { startManagementServer } from "../src/web-server.mjs";
import { temporary } from "./helpers.mjs";

async function fixture(t) {
  const store = new ProfileStore(join(await temporary(t), "connections.json"));
  const profile = await store.save({ id: "server", host: "fixture.invalid", username: "tester" });
  const file = store.file + ".remote.json", damaged = Buffer.from("{ damaged remote state\r\n\xff", "latin1");
  await writeFile(file, damaged);
  const sessions = new SessionManager({ env: {} }), remote = new RemoteManager({ store, sessions });
  t.after(async () => { await remote.close(); await sessions.close(); });
  return { store, profile, file, damaged, sessions, remote, tools: createTools(store, sessions, remote) };
}

function repairedRecords(profile) {
  return { version: 1, records: [{
    connectionId: profile.id,
    binding: createHash("sha256").update(JSON.stringify([profile.id, profile.host, profile.port, profile.username])).digest("hex"),
    operation: { id: randomUUID(), action: "restart", revision: "a".repeat(64), state: "running", step: "executing", dispatch: "possible", message: "Dispatched task" }, history: [],
  }] };
}

test("damaged task records permit local creates and same-server repairs but preserve every destructive guard", async (t) => {
  const h = await fixture(t), health = await h.tools.remote_state_status.execute({});
  assert.equal(health.state, "blocked"); assert.equal(health.file, h.file);
  const snapshot = await h.tools.connections.execute({ includeStatus: true, includeLogs: false });
  assert.equal(snapshot.remoteStorage.code, "REMOTE_STATE_INVALID");
  await h.tools.save_connection.execute({ connection: { id: "unrelated", host: "new.invalid", username: "tester" } });
  const saved = await h.tools.save_connection.execute({ connection: { ...h.profile, name: "Repair", passwordEnv: "REPAIRED_PASSWORD" }, expectedRevision: profileRevision(h.profile) });
  await assert.rejects(h.tools.save_connection.execute({ connection: { ...saved.connection, host: "different.invalid" }, expectedRevision: saved.revision }), { code: "REMOTE_STATE_INVALID" });
  await assert.rejects(h.tools.remove_connection.execute({ connectionId: h.profile.id, expectedRevision: saved.revision }), { code: "REMOTE_STATE_INVALID" });
  await assert.rejects(h.remote.assertAllIdle(), { code: "REMOTE_STATE_INVALID" });
  await assert.rejects(h.remote.preview(h.profile.id, "restart"), { code: "REMOTE_STATE_INVALID" });
  assert.deepEqual(await readFile(h.file), h.damaged);
});

test("retry preserves exact damaged bytes once, reloads all repaired records and retains possible dispatch uncertainty", async (t) => {
  const h = await fixture(t);
  const [first, concurrent] = await Promise.all([h.tools.remote_state_retry.execute({}), h.tools.remote_state_retry.execute({})]);
  assert.equal(first.state, "blocked"); assert.equal(concurrent.preservedFile, first.preservedFile);
  assert.deepEqual(await readFile(first.preservedFile), h.damaged);
  await h.remote.retryState();
  assert.equal((await readdir(h.file + ".recovery")).length, 1);
  const repaired = repairedRecords(h.profile);
  await writeFile(h.file, JSON.stringify(repaired));
  assert.equal((await h.remote.retryState()).state, "ready");
  assert.equal((await h.remote.operation(h.profile.id)).state, "unknown");
  await assert.rejects(h.remote.assertIdle(h.profile.id), { code: "REMOTE_BUSY" });
  await assert.rejects(h.remote.assertAllIdle(), { code: "REMOTE_BUSY" });
  await assert.rejects(h.remote.apply(h.profile.id, "restart", "b".repeat(64)), { code: "REMOTE_BUSY" });
  assert.deepEqual(JSON.parse(await readFile(h.file, "utf8")), repaired, "Reload must not rewrite or replay a task");
});

test("removing damaged state cannot reset task protection and a failed preservation never loads repaired state", async (t) => {
  const h = await fixture(t);
  await h.remote.storageStatus();
  await writeFile(h.file + ".recovery", "blocked directory");
  await writeFile(h.file, JSON.stringify(repairedRecords(h.profile)));
  await assert.rejects(h.remote.retryState(), { code: "REMOTE_STATE_PRESERVE_FAILED" });
  assert.equal((await h.remote.storageStatus()).state, "blocked");
  await rm(h.file + ".recovery");
  await rm(h.file);
  assert.equal((await h.remote.retryState()).state, "blocked");
  await assert.rejects(h.remote.assertAllIdle(), { code: "REMOTE_STATE_INVALID" });
});

test("authenticated storage recovery remains available and does not retain a partial load after a failed retry", async (t) => {
  const h = await fixture(t), web = await startManagementServer({ tools: h.tools });
  t.after(() => web.close());
  const call = (authorized) => fetch(new URL("api/call", web.url), { method: "POST", headers: { "Content-Type": "application/json", ...(authorized && { Authorization: "Bearer " + web.token }) }, body: JSON.stringify({ method: "remote_state_retry", args: {} }) });
  assert.equal((await call(false)).status, 401);
  const invalid = repairedRecords(h.profile); invalid.records.push({ connectionId: "broken" });
  await writeFile(h.file, JSON.stringify(invalid));
  assert.equal((await (await call(true)).json()).result.state, "blocked");
  await writeFile(h.file, JSON.stringify(repairedRecords(h.profile)));
  assert.equal((await (await call(true)).json()).result.state, "ready");
  assert.equal((await h.remote.operation(h.profile.id)).state, "unknown");
  const snapshot = await fetch(new URL("api/snapshot", web.url), { headers: { Authorization: "Bearer " + web.token } }).then((response) => response.json());
  assert.equal(snapshot.remoteStorage.state, "ready");
});
