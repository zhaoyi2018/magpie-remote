import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SessionManager } from "../src/sessions.mjs";
import { ProfileStore } from "../src/store.mjs";
import { validateProfile } from "../src/config.mjs";
import { echoServer, exchange, sshServer, temporary, until } from "./helpers.mjs";
import { networkProxy } from "./network-proxy.mjs";

function manager(t, options = {}) {
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" },
    reconnectDelayMs: 40, reconnectMaxDelayMs: 100, reconnectStableMs: 500, random: () => 0.5, ...options });
  t.after(() => sessions.close());
  return sessions;
}
async function offline(fixture) {
  for (const client of fixture.clients) client.end();
  await new Promise((resolve) => fixture.server.close(resolve));
}
async function online(fixture) {
  await new Promise((resolve, reject) => { fixture.server.once("error", reject); fixture.server.listen(fixture.port, "127.0.0.1", resolve); });
}

test("automatic reconnect is opt-in and survives configuration reload", async (t) => {
  const store = new ProfileStore(join(await temporary(t), "connections.json"));
  const profile = { id: "reconnect", host: "host.example", username: "tester", autoReconnect: true };
  await store.save(profile);
  assert.equal((await new ProfileStore(store.file).get(profile.id)).autoReconnect, true);
  assert.equal(validateProfile({ ...profile, autoReconnect: undefined }).autoReconnect, undefined);
  assert.throws(() => validateProfile({ ...profile, autoReconnect: "true" }), /布尔值/);
});

test("network recovery restores both directions but never restarts a manually stopped forward", async (t) => {
  const fixture = await sshServer(t), echo = await echoServer(t);
  const sessions = manager(t);
  const profile = { ...fixture.profile, autoReconnect: true, forwards: [
    { id: "local", direction: "c2s", bindPort: 0, targetPort: echo.port },
    { id: "remote", direction: "s2c", bindPort: 0, targetPort: echo.port },
    { id: "stopped", direction: "c2s", bindPort: 0, targetPort: echo.port },
  ] };
  await sessions.connect(profile);
  await sessions.removeForward(profile.id, "stopped");
  const old = sessions.status(profile.id).forwards;
  await offline(fixture);
  await until(() => sessions.status(profile.id).reconnect.attempts >= 2);
  for (const forward of old) await assert.rejects(exchange(forward.bindPort), /ECONNREFUSED/);
  await online(fixture);
  await until(() => sessions.status(profile.id).reconnect.state === "idle" && sessions.status(profile.id).state === "connected");
  const recovered = sessions.status(profile.id);
  assert.deepEqual(recovered.forwards.map((item) => item.id), ["local", "remote"]);
  for (const forward of recovered.forwards) assert.ok((await exchange(forward.bindPort)).length);
  recovered.reconnect.state = "mutated";
  assert.equal(sessions.status(profile.id).reconnect.state, "idle");
});

test("manual stop cancels a waiting retry and reconnect remains an explicit fresh action", async (t) => {
  const fixture = await sshServer(t), sessions = manager(t);
  const profile = { ...fixture.profile, autoReconnect: true };
  await sessions.connect(profile);
  await offline(fixture);
  await until(() => sessions.status(profile.id).reconnect.state === "waiting");
  assert.equal(sessions.isActive(profile.id), true);
  await sessions.disconnect(profile.id);
  await online(fixture);
  await sleep(220);
  assert.equal(fixture.clients.size, 0);
  assert.equal(sessions.status(profile.id).state, "disconnected");
  assert.equal(sessions.status(profile.id).reconnect.state, "stopped");
  assert.equal(sessions.isActive(profile.id), false);
  assert.equal((await sessions.connect(profile)).state, "connected");
});

test("manual stop during a retry handshake prevents later callbacks from reconnecting", async (t) => {
  const fixture = await sshServer(t, { hangAuth: true });
  const sessions = manager(t, { connectTimeoutMs: 120 });
  const failed = assert.rejects(sessions.connect({ ...fixture.profile, autoReconnect: true }), { code: "SSH_TIMEOUT" });
  await failed;
  await until(() => sessions.status(fixture.profile.id).reconnect.state === "connecting");
  await sessions.disconnect(fixture.profile.id);
  await sleep(260);
  assert.equal(sessions.status(fixture.profile.id).state, "disconnected");
  await until(() => fixture.clients.size === 0);
});

test("host close cancels retry timers and releases active and pending sessions", async (t) => {
  const fixture = await sshServer(t), sessions = manager(t);
  await sessions.connect({ ...fixture.profile, autoReconnect: true });
  await offline(fixture);
  await until(() => sessions.status(fixture.profile.id).reconnect.state === "waiting");
  await sessions.close();
  await online(fixture);
  await sleep(220);
  assert.equal(fixture.clients.size, 0);
  await assert.rejects(sessions.connect(fixture.profile), { code: "OPERATION_CANCELLED" });
});

test("authentication and trust failures pause retries without impacting another connection", async (t) => {
  const fixture = await sshServer(t), echo = await echoServer(t);
  const sessions = manager(t);
  await sessions.connect({ ...fixture.profile, id: "healthy", autoReconnect: true });
  const forward = await sessions.addForward("healthy", { id: "ok", direction: "c2s", bindPort: 0, targetPort: echo.port });
  for (const [id, properties, code] of [
    ["bad-password", {}, "SSH_AUTH_FAILED"],
    ["bad-trust", { hostFingerprint: "SHA256:" + "A".repeat(43) }, "HOST_KEY_REJECTED"],
  ]) {
    await assert.rejects(sessions.connect({ ...fixture.profile, id, autoReconnect: true, ...properties }, { credentials: { password: "wrong" } }), { code });
    assert.equal(sessions.status(id).reconnect.state, "paused");
    assert.equal(sessions.status(id).reconnect.attempts, 0);
  }
  await sleep(140);
  assert.equal(fixture.clients.size, 1);
  assert.ok((await exchange(forward.bindPort)).length);
});

test("temporary passwords are not retained for retry and require a new explicit login", async (t) => {
  const fixture = await sshServer(t), sessions = manager(t, { env: {} });
  const profile = { ...fixture.profile, passwordEnv: undefined, authMethod: "environment", autoReconnect: true };
  await sessions.connect(profile, { credentials: { password: "local-test-secret" } });
  for (const client of fixture.clients) client.end();
  await until(() => sessions.status(profile.id).reconnect.state === "paused");
  const status = sessions.status(profile.id);
  assert.equal(status.error.code, "CREDENTIALS_REQUIRED");
  assert.ok(!JSON.stringify(status).includes("local-test-secret"));
  assert.equal((await sessions.connect(profile, { credentials: { password: "local-test-secret" } })).state, "connected");
});

test("removed host trust after a network interruption pauses rather than bypassing verification", async (t) => {
  const fixture = await sshServer(t), sessions = manager(t);
  const trusted = await readFile(fixture.profile.knownHostsFile);
  const key = fixture.profile.hostFingerprint;
  const profile = { ...fixture.profile, autoReconnect: true, hostFingerprint: undefined };
  // The fingerprint path is already exercised above; use known_hosts changes here.
  const { hostPublicKey } = await import("./helpers.mjs");
  await writeFile(profile.knownHostsFile, `[127.0.0.1]:${profile.port} ssh-ed25519 ${hostPublicKey.toString("base64")}\n`);
  await sessions.connect(profile);
  await offline(fixture);
  await writeFile(profile.knownHostsFile, trusted);
  await online(fixture);
  await until(() => sessions.status(profile.id).reconnect.state === "paused");
  assert.equal(sessions.status(profile.id).error.code, "HOST_KEY_REJECTED");
  assert.equal(sessions.status(profile.id).hostFingerprint, key);
});

test("a silent network outage times out and recovers both tunnel directions without affecting another session", async (t) => {
  const fixture = await sshServer(t), echo = await echoServer(t), proxy = await networkProxy(t, fixture.port);
  const sessions = manager(t, { keepaliveIntervalMs: 40, keepaliveCountMax: 2, connectTimeoutMs: 100 });
  const profile = { ...fixture.profile, id: "interrupted", port: proxy.port, autoReconnect: true, forwards: [
    { id: "local", direction: "c2s", bindPort: 0, targetPort: echo.port },
    { id: "remote", direction: "s2c", bindPort: 0, targetPort: echo.port },
  ] };
  const connected = await sessions.connect(profile);
  await sessions.connect({ ...fixture.profile, id: "independent" });
  const healthy = await sessions.addForward("independent", { id: "healthy", direction: "c2s", bindPort: 0, targetPort: echo.port });
  proxy.interrupt();
  await until(() => sessions.status(profile.id).error?.code === "SSH_TIMEOUT");
  await until(() => sessions.status(profile.id).reconnect.attempts >= 2);
  for (const forward of connected.forwards) await assert.rejects(exchange(forward.bindPort), /ECONNREFUSED/);
  assert.ok((await exchange(healthy.bindPort)).length);
  proxy.resume();
  await until(() => sessions.status(profile.id).state === "connected" && sessions.status(profile.id).reconnect.state === "idle");
  for (const forward of sessions.status(profile.id).forwards) assert.ok((await exchange(forward.bindPort)).length);
});

test("immediate retry replaces a waiting timer without reviving a manually stopped preset", async (t) => {
  const fixture = await sshServer(t), echo = await echoServer(t);
  const sessions = manager(t, { reconnectDelayMs: 150, reconnectMaxDelayMs: 150 });
  const profile = { ...fixture.profile, autoReconnect: true, forwards: [{ id: "stopped", direction: "c2s", bindPort: 0, targetPort: echo.port }] };
  await sessions.connect(profile);
  await sessions.removeForward(profile.id, "stopped");
  await offline(fixture);
  await until(() => sessions.status(profile.id).reconnect.state === "waiting");
  await online(fixture);
  const connected = await sessions.connect(profile);
  assert.deepEqual(connected.forwards, []);
  await sleep(210);
  assert.equal(fixture.clients.size, 1);
  assert.equal(sessions.status(profile.id).connectedAt, connected.connectedAt);
});

test("initial network failure retries only when enabled and the capped delay limits repeated failures", async (t) => {
  const fixture = await sshServer(t), sessions = manager(t);
  await offline(fixture);
  await assert.rejects(sessions.connect({ ...fixture.profile, id: "manual" }), { code: "SSH_NETWORK" });
  await assert.rejects(sessions.connect({ ...fixture.profile, id: "automatic", autoReconnect: true }), { code: "SSH_NETWORK" });
  await until(() => sessions.status("automatic").reconnect.attempts >= 4);
  const status = sessions.status("automatic");
  assert.equal(status.reconnect.state, "waiting");
  assert.ok(Date.parse(status.reconnect.nextRetryAt) - Date.now() <= 100);
  assert.equal(sessions.status("manual").reconnect.attempts, 0);
  await online(fixture);
  await until(() => sessions.status("automatic").state === "connected");
  assert.equal(sessions.status("manual").state, "failed");
  assert.equal(fixture.clients.size, 1);
});
