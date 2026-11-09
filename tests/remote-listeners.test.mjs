import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loopbackHost, privateForward, verifyRemoteListener } from "../src/remote-listeners.mjs";
import { SessionManager } from "../src/sessions.mjs";
import { ProfileStore } from "../src/store.mjs";
import { createTools } from "../src/plugin.mjs";
import { echoServer, exchange, sshServer, temporary, until } from "./helpers.mjs";

test("only numeric loopback hosts are trusted, including IPv6 and mapped loopback origins", () => {
  for (const host of ["127.0.0.1", "127.3.2.1", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) assert.equal(loopbackHost(host), true, host);
  for (const host of ["localhost", "localhost.evil", "0.0.0.0", "::", "192.168.1.1", "::ffff:192.168.1.1", "127.256.1.1", "127.0.0.01", "::1%eth0", undefined]) assert.equal(loopbackHost(host), false, String(host));
  assert.equal(privateForward({ direction: "s2c", bindHost: "localhost" }).bindHost, "127.0.0.1");
});

test("listener verification refuses unknown, exposed, failed and contradictory responses", async () => {
  for (const result of [
    { code: 0, stdout: "MAGPIE_LISTENER_V1\t3425\texposed\n" },
    { code: 0, stdout: "MAGPIE_LISTENER_V1\t3425\tunknown\n" },
    { code: 1, stdout: "MAGPIE_LISTENER_V1\t3425\tloopback\n" },
    { code: 0, stdout: "MAGPIE_LISTENER_V1\t3426\tloopback\n" },
    { code: 0, stdout: "MAGPIE_LISTENER_V1\t3425\tloopback\nextra" },
  ]) await assert.rejects(verifyRemoteListener({}, 3425, async () => result), { code: "FORWARD_BIND_UNVERIFIED" });
  await assert.rejects(verifyRemoteListener({}, 3425, async () => { throw new Error("exec refused"); }), { code: "FORWARD_BIND_UNVERIFIED" });
});

test("public reverse presets remain readable but cannot be saved or started", async (t) => {
  const fixture = await sshServer(t), store = new ProfileStore(join(await temporary(t), "connections.json"));
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  t.after(() => sessions.close());
  const forward = { id: "public", direction: "s2c", bindHost: "0.0.0.0", bindPort: 0, targetPort: 80 };
  await store.save({ ...fixture.profile, autoStartForwards: false, forwards: [forward] });
  assert.equal((await store.get(fixture.profile.id)).forwards[0].bindHost, "0.0.0.0");
  await sessions.connect(await store.get(fixture.profile.id));
  await assert.rejects(sessions.addForward(fixture.profile.id, forward), { code: "FORWARD_LOOPBACK_REQUIRED" });
  const tools = createTools(store, sessions);
  await assert.rejects(async () => tools.forward_save.execute({ connectionId: fixture.profile.id, forward }), { code: "FORWARD_LOOPBACK_REQUIRED" });
  await assert.rejects(async () => tools.save_connection.execute({ connection: { ...fixture.profile, forwards: [forward] } }), { code: "FORWARD_LOOPBACK_REQUIRED" });
  assert.equal(sessions.status(fixture.profile.id).state, "connected");
});

for (const [label, options] of [["IPv4 wildcard", { remoteBindHost: "0.0.0.0" }], ["IPv6 wildcard", { remoteBindHost: "::" }], ["unverifiable listeners", { inspection: false }]]) {
  test("reverse forward rejects " + label + " and releases the remote allocation", async (t) => {
    const fixture = await sshServer(t, options), echo = await echoServer(t);
    const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
    t.after(() => sessions.close());
    await sessions.connect(fixture.profile);
    await sessions.connect({ ...fixture.profile, id: "independent" });
    const independent = await sessions.addForward("independent", { id: "kept", direction: "c2s", bindPort: 0, targetPort: echo.port });
    await assert.rejects(sessions.addForward(fixture.profile.id, { id: "remote", direction: "s2c", bindPort: 0, targetPort: echo.port }), { code: "FORWARD_BIND_UNVERIFIED" });
    assert.equal(sessions.status(fixture.profile.id).state, "failed");
    await until(() => fixture.listeners.size === 0);
    assert.deepEqual(await exchange(independent.bindPort), Buffer.from("SSH tunnel round trip"));
  });
}

test("an incoming non-loopback SSH origin never reaches the local target", async (t) => {
  const fixture = await sshServer(t, { sourceIP: "192.0.2.9" }), echo = await echoServer(t);
  let reached = false; echo.server.on("connection", () => { reached = true; });
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  t.after(() => sessions.close());
  await sessions.connect(fixture.profile);
  const forward = await sessions.addForward(fixture.profile.id, { id: "remote", direction: "s2c", bindPort: 0, targetPort: echo.port });
  await assert.rejects(exchange(forward.bindPort));
  assert.equal(reached, false);
  assert.equal(sessions.status(fixture.profile.id).state, "connected");
});
