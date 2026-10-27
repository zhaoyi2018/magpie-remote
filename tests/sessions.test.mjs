import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, connect as connectTCP } from "node:net";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "../src/sessions.mjs";
import { echoServer, exchange, keys, listen, sshServer, temporary, until } from "./helpers.mjs";

function manager(t, options = {}) {
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" }, ...options });
  t.after(() => sessions.close());
  return sessions;
}

test("authentication completes before connect; connect is idempotent", async (t) => {
  const fixture = await sshServer(t);
  const sessions = manager(t);
  const first = await sessions.connect(fixture.profile);
  assert.equal(first.state, "connected");
  assert.equal(first.hostFingerprint, fixture.profile.hostFingerprint);
  assert.equal((await sessions.connect(fixture.profile)).connectedAt, first.connectedAt);
  assert.equal(fixture.clients.size, 1);
  assert.equal((await sessions.disconnect(fixture.profile.id)).state, "disconnected");
});

test("both c2s (-L) and s2c (-R) carry real binary data and release their ports", async (t) => {
  const fixture = await sshServer(t);
  const echo = await echoServer(t);
  const sessions = manager(t);
  await sessions.connect(fixture.profile);
  const payload = randomBytes(256 * 1024);
  for (const direction of ["c2s", "s2c"]) {
    const forward = await sessions.addForward(fixture.profile.id, {
      id: direction, direction, bindPort: 0, targetPort: echo.port,
    });
    assert.equal(forward.state, "listening");
    assert.ok(forward.bindPort > 0);
    assert.deepEqual(await exchange(forward.bindPort, payload), payload);
    await sessions.removeForward(fixture.profile.id, direction);
    await assert.rejects(exchange(forward.bindPort), /ECONNREFUSED/);
    assert.equal(sessions.status(fixture.profile.id).state, "connected");
  }
});

test("SSH private-key authentication reads the configured file", async (t) => {
  const fixture = await sshServer(t);
  const file = join(await temporary(t), "client-key");
  await writeFile(file, keys.private, { mode: 0o600 });
  const sessions = manager(t, { env: {} });
  const profile = { ...fixture.profile, passwordEnv: undefined, identityFile: file };
  assert.equal((await sessions.connect(profile)).state, "connected");
});

test("removing a forward also terminates its active TCP channels", async (t) => {
  const fixture = await sshServer(t);
  const echo = await echoServer(t);
  const sessions = manager(t);
  await sessions.connect(fixture.profile);
  for (const direction of ["c2s", "s2c"]) {
    const forward = await sessions.addForward(fixture.profile.id, { id: direction, direction, bindPort: 0, targetPort: echo.port });
    const socket = connectTCP({ host: "127.0.0.1", port: forward.bindPort });
    socket.on("error", () => {});
    t.after(() => socket.destroy());
    await once(socket, "connect");
    const received = once(socket, "data");
    socket.write("active channel");
    await received;
    const closed = once(socket, "close");
    await sessions.removeForward(fixture.profile.id, direction);
    await closed;
    await assert.rejects(exchange(forward.bindPort), /ECONNREFUSED/);
  }
});

test("independent SSH sessions keep their own forwards when another disconnects", async (t) => {
  const fixture = await sshServer(t);
  const echo = await echoServer(t);
  const sessions = manager(t);
  const other = { ...fixture.profile, id: "other-server" };
  await Promise.all([sessions.connect(fixture.profile), sessions.connect(other)]);
  const first = await sessions.addForward(fixture.profile.id, { id: "web", direction: "c2s", bindPort: 0, targetPort: echo.port });
  const second = await sessions.addForward(other.id, { id: "web", direction: "c2s", bindPort: 0, targetPort: echo.port });
  await sessions.disconnect(fixture.profile.id);
  await assert.rejects(exchange(first.bindPort), /ECONNREFUSED/);
  assert.deepEqual(await exchange(second.bindPort), Buffer.from("SSH tunnel round trip"));
});

test("forwards require an established SSH session", async (t) => {
  const sessions = manager(t);
  await assert.rejects(sessions.addForward("absent", { id: "x", direction: "c2s", bindPort: 0, targetPort: 80 }), /先成功建立/);
});

test("bad credentials and untrusted host keys never report connected", async (t) => {
  const fixture = await sshServer(t);
  const sessions = manager(t, { env: { MIGPIE_TEST_PASSWORD: "wrong" } });
  await assert.rejects(sessions.connect(fixture.profile), /authentication/i);
  assert.equal(sessions.status(fixture.profile.id).state, "failed");
  await assert.rejects(sessions.connect({ ...fixture.profile, hostFingerprint: undefined }), /公钥/);
  assert.equal(sessions.status(fixture.profile.id).state, "failed");
});

test("a failed saved forward rolls back already opened listeners and the SSH session", async (t) => {
  const fixture = await sshServer(t, { rejectRemote: true });
  const blocker = createServer();
  const port = await listen(blocker);
  await new Promise((resolve) => blocker.close(resolve));
  const sessions = manager(t);
  const profile = { ...fixture.profile, forwards: [
    { id: "first", direction: "c2s", bindPort: port, targetPort: 80 },
    { id: "rejected", direction: "s2c", bindPort: 0, targetPort: 80 },
  ] };
  await assert.rejects(sessions.connect(profile));
  assert.equal(sessions.status(profile.id).state, "failed");
  assert.deepEqual(sessions.status(profile.id).forwards, []);
  await assert.rejects(exchange(port), /ECONNREFUSED/);
});

test("port conflicts and duplicate ids do not replace a working forward", async (t) => {
  const fixture = await sshServer(t);
  const echo = await echoServer(t);
  const sessions = manager(t);
  await sessions.connect(fixture.profile);
  const forward = await sessions.addForward(fixture.profile.id, { id: "x", direction: "c2s", bindPort: 0, targetPort: echo.port });
  await assert.rejects(sessions.addForward(fixture.profile.id, { id: "x", direction: "c2s", bindPort: 0, targetPort: 80 }), /已存在/);
  await assert.rejects(sessions.addForward(fixture.profile.id, { id: "y", direction: "c2s", bindPort: echo.port, targetPort: 80 }), /EADDRINUSE/);
  assert.deepEqual(await exchange(forward.bindPort), Buffer.from("SSH tunnel round trip"));
});

test("connect cancellation and timeout close the unauthenticated session", async (t) => {
  const fixture = await sshServer(t, { hangAuth: true });
  const sessions = manager(t, { connectTimeoutMs: 250 });
  const controller = new AbortController();
  const pending = sessions.connect(fixture.profile, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /取消/);
  await assert.rejects(sessions.connect(fixture.profile), /超时|Timed out/i);
  assert.equal(sessions.status(fixture.profile.id).state, "failed");
});

test("disconnect interrupts connecting sessions and never changes to failed later", async (t) => {
  const fixture = await sshServer(t, { hangAuth: true });
  const sessions = manager(t, { connectTimeoutMs: 250 });
  const pending = sessions.connect(fixture.profile);
  const rejection = assert.rejects(pending, /断开|停止|关闭/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await sessions.disconnect(fixture.profile.id);
  await rejection;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sessions.status(fixture.profile.id).state, "disconnected");
});

test("remote-forward request timeout closes the session and removes every forward", async (t) => {
  const fixture = await sshServer(t, { hangForward: true });
  const sessions = manager(t, { forwardTimeoutMs: 150 });
  await sessions.connect(fixture.profile);
  await assert.rejects(sessions.addForward(fixture.profile.id, { id: "r", direction: "s2c", bindPort: 0, targetPort: 80 }), /超时|关闭/);
  assert.equal(sessions.status(fixture.profile.id).state, "failed");
  assert.deepEqual(sessions.status(fixture.profile.id).forwards, []);
});

for (const cancelForward of ["reject", "hang", "disconnect"]) {
  test(`remote-forward cancellation ${cancelForward} closes the affected SSH session and preserves other sessions`, async (t) => {
    const fixture = await sshServer(t, { cancelForward }), echo = await echoServer(t);
    const sessions = manager(t, { forwardTimeoutMs: 200 });
    const other = { ...fixture.profile, id: "independent" };
    await sessions.connect(fixture.profile); await sessions.connect(other);
    const remote = await sessions.addForward(fixture.profile.id, { id: "remote", direction: "s2c", bindPort: 0, targetPort: echo.port });
    const local = await sessions.addForward(fixture.profile.id, { id: "local", direction: "c2s", bindPort: 0, targetPort: echo.port });
    const independent = await sessions.addForward(other.id, { id: "independent", direction: "c2s", bindPort: 0, targetPort: echo.port });
    assert.deepEqual(await exchange(remote.bindPort), Buffer.from("SSH tunnel round trip"));
    await assert.rejects(sessions.removeForward(fixture.profile.id, "remote"));
    assert.ok(["failed", "disconnected"].includes(sessions.status(fixture.profile.id).state));
    assert.deepEqual(sessions.status(fixture.profile.id).forwards, []);
    await until(() => fixture.listeners.size === 0, "remote listener survived uncertain cancellation");
    for (const port of [remote.bindPort, local.bindPort]) await assert.rejects(exchange(port), /ECONNREFUSED/);
    assert.equal(sessions.status(other.id).state, "connected");
    assert.deepEqual(await exchange(independent.bindPort), Buffer.from("SSH tunnel round trip"));
  });
}

test("an unexpected SSH disconnect cleans up client and server listeners", async (t) => {
  const fixture = await sshServer(t);
  const sessions = manager(t);
  await sessions.connect(fixture.profile);
  const ports = [];
  for (const direction of ["c2s", "s2c"]) {
    ports.push((await sessions.addForward(fixture.profile.id, { id: direction, direction, bindPort: 0, targetPort: 80 })).bindPort);
  }
  for (const client of fixture.clients) client.end();
  await until(() => sessions.status(fixture.profile.id).state === "disconnected");
  await until(() => fixture.listeners.size === 0);
  assert.deepEqual(sessions.status(fixture.profile.id).forwards, []);
  for (const port of ports) await assert.rejects(exchange(port), /ECONNREFUSED/);
});
