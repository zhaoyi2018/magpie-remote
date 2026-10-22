import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ssh2 from "ssh2";
import { SessionManager } from "../src/sessions.mjs";
import { ProfileStore } from "../src/store.mjs";
import { validateProfile } from "../src/config.mjs";
import { createTools } from "../src/plugin.mjs";
import { startManagementServer } from "../src/web-server.mjs";
import { keys, encryptedKeys } from "./fixtures.mjs";
import { echoServer, exchange, sshServer, temporary, until } from "./helpers.mjs";

function manager(t, options = {}) {
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" }, ...options });
  t.after(() => sessions.close());
  return sessions;
}

test("stable plain and encrypted fixtures parse to their declared public keys", () => {
  for (const fixture of [keys, encryptedKeys]) {
    const parsed = ssh2.utils.parseKey(fixture.private, fixture.passphrase);
    assert.ok(!(parsed instanceof Error));
    assert.equal(parsed.getPublicSSH().toString("base64"), fixture.public.split(" ")[1]);
  }
});

test("an explicit remote refusal leaves an existing local forward usable", async (t) => {
  const fixture = await sshServer(t, { rejectRemote: true });
  const echo = await echoServer(t);
  const sessions = manager(t);
  await sessions.connect(fixture.profile);
  const forward = await sessions.addForward(fixture.profile.id, { id: "working", direction: "c2s", bindPort: 0, targetPort: echo.port });
  assert.ok((await exchange(forward.bindPort)).length);
  await assert.rejects(sessions.addForward(fixture.profile.id, { id: "denied", direction: "s2c", bindPort: 0, targetPort: echo.port }), { code: "FORWARD_REJECTED" });
  const status = sessions.status(fixture.profile.id);
  assert.equal(status.state, "connected");
  assert.deepEqual(status.forwards.map((item) => item.id), ["working"]);
  assert.ok((await exchange(forward.bindPort)).length);
});

test("continuing presets is opt-in, survives reload and reports failed rules while starting later ones", async (t) => {
  const fixture = await sshServer(t, { rejectRemote: true });
  const echo = await echoServer(t);
  const store = new ProfileStore(join(await temporary(t), "connections.json"));
  const profile = { ...fixture.profile, forwardFailurePolicy: "continue", forwards: [
    { id: "first", direction: "c2s", bindPort: 0, targetPort: echo.port },
    { id: "denied", direction: "s2c", bindPort: 0, targetPort: echo.port },
    { id: "last", direction: "c2s", bindPort: 0, targetPort: echo.port },
  ] };
  await store.save(profile);
  const reloaded = await new ProfileStore(store.file).get(profile.id);
  assert.equal(reloaded.forwardFailurePolicy, "continue");
  assert.equal(validateProfile(fixture.profile).forwardFailurePolicy, undefined);
  assert.throws(() => validateProfile({ ...fixture.profile, forwardFailurePolicy: "ignore-everything" }), /forwardFailurePolicy/);
  const sessions = manager(t);
  const connected = await sessions.connect(reloaded);
  assert.equal(connected.state, "connected");
  assert.deepEqual(connected.forwards.map((item) => item.id), ["first", "last"]);
  assert.deepEqual(connected.forwardErrors.map((item) => item.id), ["denied"]);
  for (const forward of connected.forwards) assert.ok((await exchange(forward.bindPort)).length);
  connected.forwardErrors[0].message = "changed by caller";
  assert.notEqual(sessions.status(profile.id).forwardErrors[0].message, "changed by caller");
});

test("a failed local preset can be retried after its conflicting port is released", async (t) => {
  const fixture = await sshServer(t);
  const echo = await echoServer(t);
  const blocker = await echoServer(t);
  const sessions = manager(t);
  const preset = { id: "blocked", direction: "c2s", bindPort: blocker.port, targetPort: echo.port };
  const status = await sessions.connect({ ...fixture.profile, forwardFailurePolicy: "continue", forwards: [preset] });
  assert.equal(status.state, "connected");
  assert.equal(status.forwardErrors[0].id, preset.id);
  await new Promise((resolve) => blocker.server.close(resolve));
  const running = await sessions.addForward(fixture.profile.id, preset);
  assert.ok((await exchange(running.bindPort)).length);
  assert.deepEqual(sessions.status(fixture.profile.id).forwardErrors, []);
});

test("continue policy never preserves an uncertain remote allocation after timeout", async (t) => {
  const fixture = await sshServer(t, { hangForward: true });
  const echo = await echoServer(t);
  const sessions = manager(t, { forwardTimeoutMs: 150 });
  const result = assert.rejects(sessions.connect({ ...fixture.profile, forwardFailurePolicy: "continue", forwards: [
    { id: "working", direction: "c2s", bindPort: 0, targetPort: echo.port },
    { id: "uncertain", direction: "s2c", bindPort: 0, targetPort: echo.port },
    { id: "never-started", direction: "c2s", bindPort: 0, targetPort: echo.port },
  ] }), { code: "FORWARD_TIMEOUT" });
  let running;
  await until(() => (running = sessions.status(fixture.profile.id).forwards.find((item) => item.id === "working" && item.state === "listening")));
  await result;
  assert.equal(sessions.status(fixture.profile.id).state, "failed");
  assert.deepEqual(sessions.status(fixture.profile.id).forwards, []);
  await assert.rejects(exchange(running.bindPort), /ECONNREFUSED/);
});

test("a working agent is not blocked by missing environment variables or invalid fallback keys", async (t) => {
  const fixture = await sshServer(t);
  const directory = await temporary(t);
  const invalidKey = join(directory, "invalid-key");
  await writeFile(invalidKey, "not a private key");
  const key = ssh2.utils.parseKey(keys.private);
  const agent = new class extends ssh2.BaseAgent {
    getIdentities(callback) { callback(null, [key]); }
    sign(_publicKey, data, options, callback) { callback(null, key.sign(data, options.hash)); }
  }();
  const sessions = manager(t, { env: { SSH_AUTH_SOCK: agent } });
  for (const identityFile of [undefined, join(directory, "missing-key"), invalidKey]) {
    const status = await sessions.connect({ ...fixture.profile, authMethod: "agent", identityFile, passphraseEnv: "MISSING_PASSPHRASE" });
    assert.equal(status.state, "connected");
    assert.ok(status.logs.some((entry) => entry.level === "warn"));
    await sessions.disconnect(fixture.profile.id);
  }
});

test("an unencrypted private key needs no passphrase even if the optional variable is absent", async (t) => {
  const fixture = await sshServer(t);
  const file = join(await temporary(t), "client-key");
  await writeFile(file, keys.private);
  const sessions = manager(t, { env: {} });
  const status = await sessions.connect({ ...fixture.profile, authMethod: "key", identityFile: file, passphraseEnv: "MISSING_PASSPHRASE" });
  assert.equal(status.state, "connected");
});

test("encrypted keys request only a passphrase and then authenticate with transient credentials", async (t) => {
  const clientPublicKey = ssh2.utils.parseKey(encryptedKeys.private, encryptedKeys.passphrase).getPublicSSH();
  const fixture = await sshServer(t, { clientPublicKey });
  const file = join(await temporary(t), "encrypted-client-key");
  await writeFile(file, encryptedKeys.private);
  const sessions = manager(t, { env: {} });
  const profile = { ...fixture.profile, passwordEnv: undefined, authMethod: "key", identityFile: file };
  await assert.rejects(sessions.connect(profile), { code: "CREDENTIALS_REQUIRED", credentialFields: ["passphrase"] });
  await assert.rejects(sessions.connect(profile, { credentials: { passphrase: "incorrect" } }), { code: "CREDENTIALS_REQUIRED", credentialFields: ["passphrase"] });
  const status = await sessions.connect(profile, { credentials: { passphrase: encryptedKeys.passphrase } });
  assert.equal(status.state, "connected");
  assert.ok(!JSON.stringify(status).includes(encryptedKeys.passphrase));
});

test("an encrypted fallback key does not prevent a working password from authenticating", async (t) => {
  const fixture = await sshServer(t);
  const file = join(await temporary(t), "encrypted-client-key");
  await writeFile(file, encryptedKeys.private);
  const sessions = manager(t);
  assert.equal((await sessions.connect({ ...fixture.profile, authMethod: "environment", identityFile: file })).state, "connected");
});

test("configuration errors are distinguished from service expiry and never overwrite the broken file", async (t) => {
  const store = new ProfileStore(join(await temporary(t), "connections.json"));
  const sessions = manager(t);
  const web = await startManagementServer({ tools: createTools(store, sessions) });
  t.after(() => web.close());
  const headers = { Authorization: "Bearer " + web.token };
  for (const source of ["{broken", "null", JSON.stringify({ version: 1, connections: [{ id: "bad" }] })]) {
    await writeFile(store.file, source);
    const response = await fetch(new URL("api/snapshot", web.url), { headers });
    assert.equal((await response.json()).code, "CONFIG_INVALID");
    assert.equal((await fetch(web.url)).status, 200);
    await assert.rejects(store.save({ id: "valid", host: "127.0.0.1", username: "tester" }), { code: "CONFIG_INVALID" });
    assert.equal(await readFile(store.file, "utf8"), source);
  }
  const expired = await fetch(new URL("api/snapshot", web.url), { headers: { Authorization: "Bearer old" } });
  assert.equal((await expired.json()).code, "MANAGEMENT_EXPIRED");
  await writeFile(store.file, JSON.stringify({ version: 1, connections: [] }));
  assert.equal((await fetch(new URL("api/snapshot", web.url), { headers })).status, 200);
});

test("the management API returns typed credential requests without persisting passwords", async (t) => {
  const fixture = await sshServer(t);
  const store = new ProfileStore(join(await temporary(t), "connections.json"));
  const sessions = manager(t, { env: {} });
  await store.save({ ...fixture.profile, passwordEnv: undefined, authMethod: "environment" });
  const web = await startManagementServer({ tools: createTools(store, sessions) });
  t.after(() => web.close());
  const headers = { Authorization: "Bearer " + web.token, "Content-Type": "application/json" };
  const body = { method: "connect", args: { connectionId: fixture.profile.id } };
  const required = await fetch(new URL("api/call", web.url), { method: "POST", headers, body: JSON.stringify(body) });
  const error = await required.json();
  assert.equal(error.code, "CREDENTIALS_REQUIRED");
  assert.deepEqual(error.credentialFields, ["password"]);
  const connected = await fetch(new URL("api/call", web.url), { method: "POST", headers, body: JSON.stringify({ ...body, credentials: { password: "local-test-secret" } }) });
  assert.equal((await connected.json()).result.state, "connected");
  assert.ok(!(await readFile(store.file, "utf8")).includes("local-test-secret"));
});
