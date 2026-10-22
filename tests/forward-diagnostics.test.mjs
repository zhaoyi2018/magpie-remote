import test from "node:test";
import assert from "node:assert/strict";
import { Socket, connect as connectTCP } from "node:net";
import { SessionManager } from "../src/sessions.mjs";
import { echoServer, exchange, sshServer, until } from "./helpers.mjs";

test("a channel-open timeout is visible, recovers on the next request and ignores its late reply", async (t) => {
  const fixture = await sshServer(t), echo = await echoServer(t), independent = await echoServer(t);
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" }, forwardTimeoutMs: 80 });
  t.after(() => sessions.close());
  await sessions.connect(fixture.profile);
  let blocked = true, lateReject;
  for (const client of fixture.clients) {
    const [original] = client.listeners("tcpip");
    client.removeListener("tcpip", original);
    client.on("tcpip", (accept, reject, info) => {
      if (blocked && info.destPort === echo.port) { lateReject = reject; return; }
      original(accept, reject, info);
    });
  }
  const forward = await sessions.addForward(fixture.profile.id, { id: "diagnosed", direction: "c2s", bindPort: 0, targetPort: echo.port });
  const other = await sessions.addForward(fixture.profile.id, { id: "independent", direction: "c2s", bindPort: 0, targetPort: independent.port });
  const view = () => sessions.status(fixture.profile.id).forwards.find((item) => item.id === forward.id);
  assert.equal(view().targetConnection.state, "unknown");
  await assert.rejects(exchange(forward.bindPort));
  const failed = view();
  assert.equal(failed.state, "listening");
  assert.equal(failed.targetConnection.state, "failed");
  assert.equal(failed.targetConnection.error.code, "FORWARD_TARGET_TIMEOUT");
  assert.equal(failed.targetConnection.error.retryable, false);
  assert.ok(failed.targetConnection.lastAttemptAt && failed.targetConnection.lastFailureAt && failed.lastError);
  assert.ok(sessions.status(fixture.profile.id).logs.some((entry) => entry.level === "error" && /超时/.test(entry.message)));
  assert.ok((await exchange(other.bindPort)).length);
  failed.targetConnection.error.message = "mutated copy";
  assert.notEqual(view().targetConnection.error.message, "mutated copy");
  blocked = false;
  assert.ok((await exchange(forward.bindPort)).length);
  lateReject();
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = view();
  assert.equal(recovered.targetConnection.state, "succeeded");
  assert.equal(recovered.lastError, undefined);
  assert.equal(recovered.targetConnection.error, undefined);
  assert.ok(recovered.targetConnection.lastSuccessAt && recovered.targetConnection.lastFailureAt);
  assert.equal(sessions.status(fixture.profile.id).state, "connected");
  assert.ok(sessions.status(fixture.profile.id).logs.some((entry) => /目标连接已恢复/.test(entry.message)));
});

test("remote forwarding reports local target timeouts and recovery without restarting SSH", async (t) => {
  const fixture = await sshServer(t), echo = await echoServer(t);
  let blocked = true;
  const sessions = new SessionManager({
    env: { MIGPIE_TEST_PASSWORD: "local-test-secret" }, forwardTimeoutMs: 80,
    connectTarget: (options) => blocked ? new Socket() : connectTCP(options),
  });
  t.after(() => sessions.close());
  await sessions.connect(fixture.profile);
  const forward = await sessions.addForward(fixture.profile.id, { id: "remote", direction: "s2c", bindPort: 0, targetPort: echo.port });
  await assert.rejects(exchange(forward.bindPort));
  let snapshot = sessions.status(fixture.profile.id);
  assert.equal(snapshot.forwards[0].targetConnection.error.code, "FORWARD_TARGET_TIMEOUT");
  assert.equal(snapshot.forwards[0].state, "listening");
  blocked = false;
  assert.ok((await exchange(forward.bindPort)).length);
  snapshot = sessions.status(fixture.profile.id);
  assert.equal(snapshot.forwards[0].targetConnection.state, "succeeded");
  assert.equal(snapshot.forwards[0].lastError, undefined);
  assert.equal(snapshot.state, "connected");
});

test("a real refused target recovers in both directions and keeps its error in history", async (t) => {
  const fixture = await sshServer(t), echo = await echoServer(t);
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  t.after(() => sessions.close());
  await sessions.connect(fixture.profile);
  for (const direction of ["c2s", "s2c"]) {
    await new Promise((resolve) => echo.server.close(resolve));
    const forward = await sessions.addForward(fixture.profile.id, { id: direction, direction, bindPort: 0, targetPort: echo.port });
    await assert.rejects(exchange(forward.bindPort));
    let snapshot = sessions.status(fixture.profile.id);
    assert.equal(snapshot.forwards.find((item) => item.id === direction).targetConnection.error.code, "FORWARD_TARGET_FAILED");
    await new Promise((resolve) => echo.server.listen(echo.port, "127.0.0.1", resolve));
    assert.ok((await exchange(forward.bindPort)).length);
    snapshot = sessions.status(fixture.profile.id);
    assert.equal(snapshot.forwards.find((item) => item.id === direction).lastError, undefined);
    assert.ok(snapshot.logs.some((entry) => entry.level === "error" && entry.message.includes(direction)));
    await sessions.removeForward(fixture.profile.id, direction);
  }
});

test("an older request failure cannot replace the result of a newer successful request", async (t) => {
  const fixture = await sshServer(t), echo = await echoServer(t);
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  t.after(() => sessions.close());
  await sessions.connect(fixture.profile);
  let delayed;
  for (const client of fixture.clients) {
    const [original] = client.listeners("tcpip");
    client.removeListener("tcpip", original);
    client.on("tcpip", (accept, reject, info) => {
      if (!delayed) { delayed = reject; return; }
      original(accept, reject, info);
    });
  }
  const forward = await sessions.addForward(fixture.profile.id, { id: "parallel", direction: "c2s", bindPort: 0, targetPort: echo.port });
  const older = connectTCP({ host: "127.0.0.1", port: forward.bindPort });
  older.on("error", () => {});
  t.after(() => older.destroy());
  await until(() => delayed);
  assert.ok((await exchange(forward.bindPort)).length);
  delayed();
  await until(() => sessions.status(fixture.profile.id).logs.some((entry) => entry.level === "error"));
  const current = sessions.status(fixture.profile.id).forwards[0];
  assert.equal(current.targetConnection.state, "succeeded");
  assert.equal(current.lastError, undefined);
});
