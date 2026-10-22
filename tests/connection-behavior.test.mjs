import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import ssh2 from "ssh2";
import { validateProfile } from "../src/config.mjs";
import { createPlugin, closePlugin } from "../src/plugin.mjs";
import { ProfileStore } from "../src/store.mjs";
import { SessionManager } from "../src/sessions.mjs";
import { echoServer, exchange, keys, sshServer, temporary, until } from "./helpers.mjs";

test("connection authentication and behavior settings survive reload and reject invalid values", async (t) => {
  const store = new ProfileStore(join(await temporary(t), "connections.json"));
  const profile = { id: "configured", host: "host.example", username: "dev", authMethod: "agent", autoStartForwards: false, autoConnect: true };
  await store.save(profile);
  const reloaded = await new ProfileStore(store.file).get(profile.id);
  assert.equal(reloaded.authMethod, "agent");
  assert.equal(reloaded.autoStartForwards, false);
  assert.equal(reloaded.autoConnect, true);
  for (const field of ["autoStartForwards", "autoConnect"]) {
    assert.throws(() => validateProfile({ ...profile, [field]: "false" }), /布尔值/);
  }
  assert.throws(() => validateProfile({ ...profile, authMethod: "unknown" }), /authMethod/);
});

test("disabling automatic forwards keeps presets and allows manual forwarding after authentication", async (t) => {
  const fixture = await sshServer(t);
  const echo = await echoServer(t);
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  t.after(() => sessions.close());
  const forwards = ["c2s", "s2c"].map((direction) => ({ id: direction, direction, bindPort: 0, targetPort: echo.port }));
  const profile = { ...fixture.profile, authMethod: "environment", autoStartForwards: false, forwards };
  const connected = await sessions.connect(profile);
  assert.equal(connected.state, "connected");
  assert.deepEqual(connected.forwards, []);
  assert.equal(profile.forwards.length, 2);
  for (const preset of forwards) {
    const running = await sessions.addForward(profile.id, preset);
    assert.deepEqual(await exchange(running.bindPort), Buffer.from("SSH tunnel round trip"));
  }
  await sessions.disconnect(profile.id);
  const reconnected = await sessions.connect({ ...profile, autoStartForwards: true });
  assert.equal(reconnected.forwards.length, 2);
  for (const running of reconnected.forwards) assert.deepEqual(await exchange(running.bindPort), Buffer.from("SSH tunnel round trip"));
});

test("system agent preference uses the host agent before configured password fallback", async (t) => {
  const fixture = await sshServer(t);
  const attempts = [];
  fixture.server.on("connection", (client) => client.on("authentication", (context) => attempts.push(context.method)));
  const key = ssh2.utils.parseKey(keys.private);
  const agent = new class extends ssh2.BaseAgent {
    getIdentities(callback) { callback(null, [key]); }
    sign(_publicKey, data, options, callback) { callback(null, key.sign(data, options.hash)); }
  }();
  const sessions = new SessionManager({ env: { SSH_AUTH_SOCK: agent, MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  t.after(() => sessions.close());
  assert.equal((await sessions.connect({ ...fixture.profile, authMethod: "agent" })).state, "connected");
  assert.ok(attempts.includes("publickey"));
  assert.ok(!attempts.includes("password"));
});

test("private-key preference and unavailable-agent fallback authenticate with their configured credentials", async (t) => {
  const fixture = await sshServer(t);
  const attempts = [];
  fixture.server.on("connection", (client) => client.on("authentication", (context) => attempts.push(context.method)));
  const file = join(await temporary(t), "client-key");
  await writeFile(file, keys.private, { mode: 0o600 });
  const unavailableAgent = new class extends ssh2.BaseAgent {
    getIdentities(callback) { callback(new Error("No agent available")); }
  }();
  const sessions = new SessionManager({ env: { SSH_AUTH_SOCK: unavailableAgent, MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  t.after(() => sessions.close());
  await sessions.connect({ ...fixture.profile, authMethod: "key", identityFile: file });
  assert.ok(attempts.includes("publickey"));
  assert.ok(!attempts.includes("password"));
  await sessions.disconnect(fixture.profile.id);
  attempts.length = 0;
  assert.equal((await sessions.connect({ ...fixture.profile, authMethod: "agent" })).state, "connected");
  assert.ok(attempts.includes("password"));
});

test("host startup reconnects only opted-in profiles and respects automatic-forward preferences", async (t) => {
  const fixture = await sshServer(t);
  const echo = await echoServer(t);
  const directory = await temporary(t);
  const file = join(directory, "client-key");
  await writeFile(file, keys.private, { mode: 0o600 });
  const store = new ProfileStore(join(directory, "migpie-remote", "connections.json"));
  const profile = { ...fixture.profile, passwordEnv: undefined, identityFile: file, authMethod: "key", autoConnect: true,
    forwards: [{ id: "web", direction: "c2s", bindPort: 0, targetPort: echo.port }] };
  await store.save(profile);
  await store.save({ ...profile, id: "manual", autoConnect: false });
  await store.save({ ...profile, id: "no-forwards", autoStartForwards: false });
  const hooks = await createPlugin({ directory }, { webUI: false });
  t.after(() => closePlugin(hooks));
  await until(async () => (await hooks.tool.connections.execute({})).filter((row) => row.session.state === "connected").length === 2);
  const rows = await hooks.tool.connections.execute({});
  assert.equal(rows.find((row) => row.connection.id === "manual").session.state, "disconnected");
  assert.deepEqual(rows.find((row) => row.connection.id === "no-forwards").session.forwards, []);
  await until(async () => (await hooks.tool.status.execute({ connectionId: profile.id })).forwards.length === 1);
  const forward = (await hooks.tool.status.execute({ connectionId: profile.id })).forwards[0];
  assert.deepEqual(await exchange(forward.bindPort), Buffer.from("SSH tunnel round trip"));
  await closePlugin(hooks);
  await assert.rejects(exchange(forward.bindPort), /ECONNREFUSED/);
});

test("closing the host cancels an automatic connection still waiting for authentication", async (t) => {
  const fixture = await sshServer(t, { hangAuth: true });
  const directory = await temporary(t);
  const file = join(directory, "client-key");
  await writeFile(file, keys.private, { mode: 0o600 });
  const store = new ProfileStore(join(directory, "migpie-remote", "connections.json"));
  await store.save({ ...fixture.profile, passwordEnv: undefined, identityFile: file, autoConnect: true });
  const hooks = await createPlugin({ directory }, { webUI: false });
  t.after(() => closePlugin(hooks));
  await until(() => fixture.clients.size > 0);
  await closePlugin(hooks);
  assert.equal((await hooks.tool.status.execute({ connectionId: fixture.profile.id })).state, "disconnected");
  await until(() => fixture.clients.size === 0);
});
