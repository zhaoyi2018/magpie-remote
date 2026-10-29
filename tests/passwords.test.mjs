import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { PasswordVault } from "../src/passwords.mjs";
import { ProfileStore, profileRevision } from "../src/store.mjs";
import { SessionManager } from "../src/sessions.mjs";
import { createTools } from "../src/plugin.mjs";
import { startManagementServer } from "../src/web-server.mjs";
import { sshServer, startPagePlugin, temporary, until } from "./helpers.mjs";

const profile = { id: "password-server", host: "host.example", username: "dev", authMethod: "password" };
const secret = "  密码 with spaces  ";
const rejectsCredential = { code: "CREDENTIALS_REQUIRED" };
async function storeFor(t) { return new ProfileStore(join(await temporary(t), "connections.json")); }

test("passwords survive reload as authenticated ciphertext with a separate local key", async (t) => {
  const store = await storeFor(t);
  await store.save(profile, { password: secret });
  const source = await readFile(store.file, "utf8");
  assert.ok(!source.includes(secret));
  assert.equal(JSON.parse(source).connections[0].password, undefined);
  const reloaded = new ProfileStore(store.file), saved = await reloaded.get(profile.id);
  assert.equal(await reloaded.passwordVault.decrypt(saved), secret);
  assert.equal((await readFile(store.passwordVault.file)).length, 32);
  if (process.platform !== "win32") assert.equal((await stat(store.passwordVault.file)).mode & 0o777, 0o600);
  const second = await store.save({ ...profile, id: "other" }, { password: secret });
  assert.notEqual(second.encryptedPassword.iv, saved.encryptedPassword.iv);
  assert.equal(await reloaded.passwordVault.decrypt(second), secret);
});

test("edits preserve an omitted password, replace an explicit password, and remove it when changing authentication", async (t) => {
  const store = await storeFor(t);
  const first = await store.save(profile, { password: secret });
  const key = await readFile(store.passwordVault.file);
  const unchanged = await store.save(profile, { expectedRevision: profileRevision(first) });
  assert.equal(profileRevision(unchanged), profileRevision(first));
  assert.equal((await store.listBackups()).length, 0);
  const moved = await store.save({ ...profile, host: "other.example", username: "other-user", port: 2222 }, { expectedRevision: profileRevision(first) });
  assert.equal(await store.passwordVault.decrypt(moved), secret);
  await assert.rejects(store.passwordVault.decrypt({ ...moved, host: first.host }), rejectsCredential);
  const replaced = await store.save({ ...moved }, { expectedRevision: profileRevision(moved), password: "new-password" });
  assert.equal(await store.passwordVault.decrypt(replaced), "new-password");
  const beforeConflict = await readFile(store.file);
  await assert.rejects(store.save(profile, { expectedRevision: profileRevision(first), password: "stale-password" }), { code: "CONFIG_CONFLICT" });
  assert.deepEqual(await readFile(store.file), beforeConflict);
  assert.deepEqual(await readFile(store.passwordVault.file), key);
  const switched = await store.save({ ...profile, authMethod: "agent" }, { expectedRevision: profileRevision(replaced) });
  assert.equal(switched.encryptedPassword, undefined);
  await assert.rejects(store.save(profile, { expectedRevision: profileRevision(switched) }), rejectsCredential);
  assert.throws(() => store.save(profile, { password: "" }), /密码长度/);
});

test("tampering, another connection, and a missing key cannot decrypt or silently replace the local key", async (t) => {
  const store = await storeFor(t), saved = await store.save(profile, { password: secret });
  await assert.rejects(store.passwordVault.decrypt({ ...saved, id: "another-server" }), rejectsCredential);
  const tag = Buffer.from(saved.encryptedPassword.tag, "base64"); tag[0] ^= 1;
  await assert.rejects(store.passwordVault.decrypt({ ...saved, encryptedPassword: { ...saved.encryptedPassword, tag: tag.toString("base64") } }), rejectsCredential);
  await rm(store.passwordVault.file);
  await assert.rejects(new PasswordVault(store.passwordVault.file).decrypt(saved), rejectsCredential);
  await assert.rejects(readFile(store.passwordVault.file), { code: "ENOENT" });
});

test("concurrent vault instances publish one complete key and keep all ciphertext decryptable", async (t) => {
  const file = join(await temporary(t), "password.key");
  const encrypted = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const value = { ...profile, id: `server-${index}` };
    return { ...value, encryptedPassword: await new PasswordVault(file).encrypt(secret, value) };
  }));
  for (const saved of encrypted) assert.equal(await new PasswordVault(file).decrypt(saved), secret);
});

test("configuration backups restore usable encrypted passwords without containing the key or plaintext", async (t) => {
  const store = await storeFor(t), first = await store.save(profile, { password: secret });
  const backup = await store.createBackup();
  await store.save(profile, { expectedRevision: profileRevision(first), password: "replacement" });
  const contents = await readFile(join(store.backupDirectory, backup.id + ".json"), "utf8");
  assert.ok(!contents.includes(secret));
  assert.ok(!contents.includes((await readFile(store.passwordVault.file)).toString("base64")));
  const preview = await store.previewRestore(backup.id);
  await store.restore(backup.id, preview.revision);
  const reloaded = new ProfileStore(store.file);
  assert.equal(await reloaded.passwordVault.decrypt(await reloaded.get(profile.id)), secret);
});

test("the page saves a password then connects without a second credential request and never returns secrets", async (t) => {
  const fixture = await sshServer(t), store = await storeFor(t);
  const sessions = new SessionManager({ env: {} });
  t.after(() => sessions.close());
  const tools = createTools(store, sessions), web = await startManagementServer({ tools });
  t.after(() => web.close());
  const headers = { Authorization: "Bearer " + web.token, "Content-Type": "application/json" };
  async function call(method, args, credentials) {
    const response = await fetch(new URL("api/call", web.url), { method: "POST", headers, body: JSON.stringify({ method, args, credentials }) });
    return { status: response.status, body: await response.json() };
  }
  const connection = { ...fixture.profile, passwordEnv: undefined, authMethod: "password" };
  const saved = await call("save_connection", { connection, expectedRevision: null }, { password: "local-test-secret" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.result.hasSavedPassword, true);
  assert.equal(saved.body.result.connection.encryptedPassword, undefined);
  const connected = await call("connect", { connectionId: connection.id });
  assert.equal(connected.body.result.state, "connected");
  const snapshot = await fetch(new URL("api/snapshot", web.url), { headers }).then((response) => response.json());
  assert.equal(snapshot.connections[0].hasSavedPassword, true);
  for (const result of [saved.body, snapshot, connected.body]) {
    assert.ok(!JSON.stringify(result).includes("local-test-secret"));
    assert.ok(!JSON.stringify(result).includes("encryptedPassword"));
  }
  assert.ok(!(await readFile(store.file, "utf8")).includes("local-test-secret"));
  await tools.disconnect.execute({ connectionId: connection.id });
  const edited = await call("save_connection", { connection: { ...saved.body.result.connection, name: "Renamed" }, expectedRevision: saved.body.result.revision });
  assert.equal(edited.body.result.hasSavedPassword, true);
  assert.equal((await call("connect", { connectionId: connection.id })).body.result.state, "connected");
  const internal = await store.get(connection.id);
  assert.throws(() => tools.save_connection.execute({ connection: internal }), /密码密文由本机生成/);
  assert.equal((await call("save_connection", { connection }, { passphrase: "not-a-password" })).status, 400);
});

test("host restart and network reconnect use the encrypted saved password", async (t) => {
  const fixture = await sshServer(t), directory = await temporary(t);
  const store = new ProfileStore(join(directory, "migpie-remote", "connections.json"));
  const connection = { ...fixture.profile, passwordEnv: undefined, authMethod: "password", autoConnect: true, autoReconnect: true };
  await store.save(connection, { password: "local-test-secret" });
  const { call } = await startPagePlugin(t, directory);
  const state = async () => call("status", { connectionId: connection.id });
  await until(async () => (await state()).state === "connected");
  const previous = new Set(fixture.clients);
  for (const client of previous) client.end();
  await until(async () => [...fixture.clients].some((client) => !previous.has(client)) && (await state()).state === "connected");
  assert.ok(!JSON.stringify(await call("connections")).includes("local-test-secret"));
});

test("a missing saved-password key requests credentials and permits a temporary login without replacing the key", async (t) => {
  const fixture = await sshServer(t), store = await storeFor(t);
  const sessions = new SessionManager({ env: {} });
  t.after(() => sessions.close());
  const tools = createTools(store, sessions);
  const connection = { ...fixture.profile, passwordEnv: undefined, authMethod: "password", autoReconnect: true };
  await tools.save_connection.execute({ connection }, { credentials: { password: "local-test-secret" } });
  await rm(store.passwordVault.file);
  await assert.rejects(tools.connect.execute({ connectionId: connection.id }), rejectsCredential);
  assert.equal(sessions.status(connection.id).reconnect.state, "paused");
  const temporary = await tools.connect.execute({ connectionId: connection.id }, { credentials: { password: "local-test-secret" } });
  assert.equal(temporary.state, "connected");
  await assert.rejects(readFile(store.passwordVault.file), { code: "ENOENT" });
  assert.ok(!(await readFile(store.file, "utf8")).includes("local-test-secret"));
});
