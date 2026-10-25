import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ProfileStore, profileRevision } from "../src/store.mjs";
import { SessionManager } from "../src/sessions.mjs";
import { createTools } from "../src/plugin.mjs";
import { echoServer, exchange, sshServer, temporary, until } from "./helpers.mjs";

const profile = { id: "saved", host: "host.example", username: "tester", passwordEnv: "PASSWORD_REFERENCE" };
async function storeFor(t) { return new ProfileStore(join(await temporary(t), "connections.json")); }

test("writes back up the previous valid configuration and retain the latest five snapshots", async (t) => {
  const store = await storeFor(t);
  await assert.rejects(store.createBackup(), { code: "CONFIG_BACKUP_EMPTY" });
  await store.save(profile);
  assert.deepEqual(await store.listBackups(), []);
  for (let i = 1; i <= 7; i++) await store.save({ ...profile, name: `revision-${i}` }, { expectedRevision: profileRevision(await store.get(profile.id)) });
  const reloaded = new ProfileStore(store.file);
  const backups = await reloaded.listBackups();
  assert.equal(backups.length, 5);
  assert.ok(backups.every((backup) => backup.valid && backup.reason === "automatic"));
  const names = await Promise.all(backups.map(async (backup) => (await reloaded.previewRestore(backup.id)).connections[0].name));
  assert.deepEqual(names, [6, 5, 4, 3, 2].map((i) => `revision-${i}`));
  assert.equal((await reloaded.get(profile.id)).name, "revision-7");
  const manual = await reloaded.createBackup();
  assert.equal(manual.reason, "manual");
  assert.ok(!JSON.stringify(manual).includes("PASSWORD_REFERENCE"));
  const contents = JSON.parse(await readFile(join(store.backupDirectory, manual.id + ".json")));
  assert.equal(contents.connections[0].passwordEnv, "PASSWORD_REFERENCE");
  assert.equal(contents.connections[0].password, undefined);
  assert.equal((await reloaded.listBackups()).length, 5);
});

test("restore previews removals, preserves the previous configuration and survives reload", async (t) => {
  const store = await storeFor(t);
  await store.save(profile);
  const backup = await store.createBackup();
  await store.save({ ...profile, id: "extra" });
  const preview = await store.previewRestore(backup.id);
  assert.equal(preview.currentCount, 2);
  assert.deepEqual(preview.removed.map((item) => item.id), ["extra"]);
  assert.ok(!JSON.stringify(preview).includes("PASSWORD_REFERENCE"));
  const restored = await store.restore(backup.id, preview.revision);
  assert.equal(restored.connectionCount, 1);
  assert.equal((await new ProfileStore(store.file).list()).length, 1);
  const preserved = await store.previewRestore(restored.preserved.backupId);
  assert.equal(preserved.connectionCount, 2);
});

test("unchanged saves and skipped imports do not rotate useful backups", async (t) => {
  const store = await storeFor(t);
  await store.save(profile);
  await store.save({ ...profile, name: "latest" }, { expectedRevision: profileRevision(await store.get(profile.id)) });
  const backups = await store.listBackups();
  for (let i = 0; i < 6; i++) {
    await store.save({ ...profile, name: "latest" }, { expectedRevision: profileRevision(await store.get(profile.id)) });
    await store.importProfiles([profile]);
  }
  assert.deepEqual(await store.listBackups(), backups);
  assert.equal((await store.previewRestore(backups[0].id)).connections[0].name, "saved");
});

test("damaged current config stays untouched until explicit restore and its exact bytes are retained", async (t) => {
  const store = await storeFor(t);
  await store.save(profile);
  const backup = await store.createBackup();
  const damaged = Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0xff, 0x00]);
  await writeFile(store.file, damaged);
  await assert.rejects(store.save(profile), { code: "CONFIG_INVALID" });
  await assert.rejects(store.createBackup(), { code: "CONFIG_INVALID" });
  assert.equal((await store.listBackups()).length, 1);
  const preview = await store.previewRestore(backup.id);
  assert.equal(preview.currentValid, false);
  assert.equal(preview.currentCount, null);
  assert.deepEqual(await readFile(store.file), damaged);
  const result = await store.restore(backup.id, preview.revision);
  assert.deepEqual(await readFile(result.preserved.recoveryFile), damaged);
  assert.equal((await store.get(profile.id)).host, profile.host);
});

test("stale previews cannot overwrite changes to either the current file or selected backup", async (t) => {
  const store = await storeFor(t);
  await store.save(profile);
  const backup = await store.createBackup();
  let preview = await store.previewRestore(backup.id);
  await store.save({ ...profile, name: "newer" }, { expectedRevision: profileRevision(await store.get(profile.id)) });
  await assert.rejects(store.restore(backup.id, preview.revision), { code: "CONFIG_RESTORE_STALE" });
  preview = await store.previewRestore(backup.id);
  const file = join(store.backupDirectory, backup.id + ".json");
  await writeFile(file, (await readFile(file, "utf8")) + "\n");
  await assert.rejects(store.restore(backup.id, preview.revision), { code: "CONFIG_RESTORE_STALE" });
  assert.equal((await store.get(profile.id)).name, "newer");
});

test("invalid backup files are isolated and path traversal cannot select arbitrary files", async (t) => {
  const store = await storeFor(t);
  await store.save(profile);
  const good = await store.createBackup(), bad = await store.createBackup();
  const file = join(store.backupDirectory, bad.id + ".json");
  const data = JSON.parse(await readFile(file));
  data.connections[0].password = "unsupported-secret";
  await writeFile(file, JSON.stringify(data));
  const listed = await store.listBackups();
  assert.equal(listed.find((item) => item.id === good.id).valid, true);
  assert.equal(listed.find((item) => item.id === bad.id).valid, false);
  for (const id of [bad.id, "../connections", store.file]) await assert.rejects(store.previewRestore(id), { code: "CONFIG_BACKUP_INVALID" });
  assert.equal((await store.previewRestore(good.id)).connectionCount, 1);
});

test("backup storage failure leaves current config intact and the write queue can recover", async (t) => {
  const store = await storeFor(t);
  await store.save(profile);
  const before = await readFile(store.file);
  await writeFile(store.backupDirectory, "blocked directory");
  await assert.rejects(store.save({ ...profile, name: "lost" }, { expectedRevision: profileRevision(await store.get(profile.id)) }), { code: "CONFIG_BACKUP_FAILED" });
  assert.deepEqual(await readFile(store.file), before);
  await rm(store.backupDirectory);
  await store.save({ ...profile, name: "recovered" }, { expectedRevision: profileRevision(await store.get(profile.id)) });
  assert.equal((await store.get(profile.id)).name, "recovered");
  assert.ok(!(await readdir(join(store.file, ".."))).some((file) => file.endsWith(".tmp")));
});

test("failed main-file commits preserve every historical backup across repeated saves and restores", async (t) => {
  const directory = await temporary(t), file = join(directory, "connections.json");
  let blocked = false;
  const store = new ProfileStore(file, { renameFile: async (from, to) => {
    if (blocked && to === file) throw Object.assign(new Error("Main configuration is locked"), { code: "EPERM" });
    return rename(from, to);
  } });
  await store.save(profile);
  for (let i = 1; i <= 5; i++) await store.save({ ...profile, name: `revision-${i}` }, { expectedRevision: profileRevision(await store.get(profile.id)) });
  const before = await readFile(file), backups = await store.listBackups();
  const sources = await Promise.all(backups.map((backup) => readFile(join(store.backupDirectory, backup.id + ".json"))));
  const preview = await store.previewRestore(backups.at(-1).id);
  blocked = true;
  for (let i = 0; i < 6; i++) {
    await assert.rejects(store.save({ ...profile, name: "uncommitted" }, { expectedRevision: profileRevision(await store.get(profile.id)) }), { code: "CONFIG_WRITE_FAILED" });
    await assert.rejects(store.restore(preview.backupId, preview.revision), { code: "CONFIG_WRITE_FAILED" });
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await store.listBackups(), backups);
  }
  for (let i = 0; i < backups.length; i++) assert.deepEqual(await readFile(join(store.backupDirectory, backups[i].id + ".json")), sources[i]);
  blocked = false;
  await store.save({ ...profile, name: "recovered" }, { expectedRevision: profileRevision(await store.get(profile.id)) });
  assert.equal((await store.get(profile.id)).name, "recovered");
  assert.equal((await store.listBackups()).length, store.backupLimit);
});

test("backup pruning failure is a warning after a successful commit and a later write retries cleanup", async (t) => {
  const file = join(await temporary(t), "connections.json"), warnings = [];
  let blocked = false;
  const store = new ProfileStore(file, { backupLimit: 2, removeFile: async (path, options) => {
    if (blocked && path.startsWith(file + ".backups")) throw new Error("Backup cleanup is unavailable");
    return rm(path, options);
  }, onWarning: (warning) => warnings.push(warning) });
  await store.save(profile);
  for (let i = 1; i <= 2; i++) await store.save({ ...profile, name: `revision-${i}` }, { expectedRevision: profileRevision(await store.get(profile.id)) });
  blocked = true;
  await store.save({ ...profile, name: "committed" }, { expectedRevision: profileRevision(await store.get(profile.id)) });
  assert.equal((await store.get(profile.id)).name, "committed");
  assert.equal((await store.listBackups()).length, 3);
  assert.equal(warnings.at(-1).code, "CONFIG_BACKUP_CLEANUP_FAILED");
  blocked = false;
  await store.createBackup();
  assert.equal((await store.listBackups()).length, 2);
});

test("restore requires an explicit stop, releases tunnels and leaves restored auto-connect profiles stopped", async (t) => {
  const store = await storeFor(t), fixture = await sshServer(t), echo = await echoServer(t);
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  t.after(() => sessions.close());
  const tools = createTools(store, sessions);
  await store.save({ ...fixture.profile, autoConnect: true, autoReconnect: true, forwards: [{ id: "local", direction: "c2s", bindPort: 0, targetPort: echo.port }] });
  const backup = await tools.config_backup.execute();
  const connected = await tools.connect.execute({ connectionId: fixture.profile.id });
  const preview = await tools.config_restore_preview.execute({ backupId: backup.id });
  const args = { backupId: backup.id, revision: preview.revision };
  await assert.rejects(tools.config_restore.execute(args), { code: "CONFIG_RESTORE_ACTIVE" });
  assert.ok((await exchange(connected.forwards[0].bindPort)).length);
  await tools.config_restore.execute({ ...args, stopConnections: true });
  assert.equal(sessions.status(fixture.profile.id).reconnect.state, "stopped");
  await assert.rejects(exchange(connected.forwards[0].bindPort), /ECONNREFUSED/);
  await sleep(80);
  assert.equal(fixture.clients.size, 0);
  assert.equal((await tools.connect.execute({ connectionId: fixture.profile.id })).state, "connected");
});

test("restoring during network retries cancels future attempts and excludes concurrent mutations", async (t) => {
  const store = await storeFor(t), fixture = await sshServer(t);
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" }, reconnectDelayMs: 30, reconnectMaxDelayMs: 60 });
  t.after(() => sessions.close());
  const tools = createTools(store, sessions);
  await store.save({ ...fixture.profile, autoReconnect: true });
  const backup = await store.createBackup(), preview = await store.previewRestore(backup.id);
  await tools.connect.execute({ connectionId: fixture.profile.id });
  for (const client of fixture.clients) client.end();
  await new Promise((resolve) => fixture.server.close(resolve));
  await until(() => sessions.status(fixture.profile.id).reconnect.state === "waiting");
  await assert.rejects(tools.config_restore.execute({ backupId: backup.id, revision: preview.revision }), { code: "CONFIG_RESTORE_ACTIVE" });
  const restoring = tools.config_restore.execute({ backupId: backup.id, revision: preview.revision, stopConnections: true });
  assert.throws(() => tools.save_connection.execute({ connection: profile }), { code: "CONFIG_RESTORE_BUSY" });
  await assert.rejects(tools.config_restore.execute({ backupId: backup.id, revision: preview.revision }), { code: "CONFIG_RESTORE_BUSY" });
  await restoring;
  await new Promise((resolve) => fixture.server.listen(fixture.port, "127.0.0.1", resolve));
  await sleep(150);
  assert.equal(fixture.clients.size, 0);
  assert.equal(sessions.status(fixture.profile.id).reconnect.state, "stopped");
});

test("restore interrupts an in-flight connection and stale rejection does not interrupt a healthy one", async (t) => {
  const store = await storeFor(t), fixture = await sshServer(t, { hangAuth: true });
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  t.after(() => sessions.close());
  const tools = createTools(store, sessions);
  await store.save(fixture.profile);
  const backup = await store.createBackup(), preview = await store.previewRestore(backup.id);
  const connecting = assert.rejects(tools.connect.execute({ connectionId: fixture.profile.id }), /取消/);
  await until(() => fixture.clients.size === 1);
  await assert.rejects(tools.config_restore.execute({ backupId: backup.id, revision: "stale", stopConnections: true }), { code: "CONFIG_RESTORE_STALE" });
  assert.equal(sessions.status(fixture.profile.id).state, "connecting");
  await tools.config_restore.execute({ backupId: backup.id, revision: preview.revision, stopConnections: true });
  await connecting;
  await until(() => fixture.clients.size === 0);
});
