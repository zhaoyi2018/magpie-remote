import test from "node:test";
import assert from "node:assert/strict";
import { forwardConflictScript, forwardRejectionMessage, parseForwardConflict } from "../src/forward-conflicts.mjs";
import { SessionManager } from "../src/sessions.mjs";
import { echoServer, exchange, sshServer, until } from "./helpers.mjs";

const wrap = (rows = "", source = "ss", port = 3425) => `MAGPIE_FORWARD_CONFLICT_V1\t${port}\t${source}\n${rows}MAGPIE_FORWARD_CONFLICT_END\n`;
const sockets = 'SS\tLISTEN 0 128 127.0.0.1:3425 0.0.0.0:* users:(("node",pid=1234,fd=8)) uid:1000 ino:42\n';
const metadata = "PS\t 1234 alice node\nUID\t1000\talice\n";
const forward = { bindHost: "127.0.0.1", bindPort: 3425 };

test("ss inspection associates IPv4/IPv6 sockets with multiple process owners", () => {
  const result = parseForwardConflict(wrap(sockets + metadata
    + 'SS\tLISTEN 0 128 [::]:3425 [::]:* users:(("sshd",pid=2222,fd=6),("systemd",pid=1,fd=7))\n'
    + "PS\t2222 root sshd\nPS\t1 root systemd\n"), 3425);
  assert.equal(result.available, true);
  assert.equal(result.listeners[0].address, "127.0.0.1:3425");
  assert.deepEqual(result.listeners[0].processes, [{ pid: "1234", name: "node", user: "alice", uid: "1000" }]);
  assert.equal(result.listeners[1].address, "[::]:3425");
  assert.deepEqual(result.listeners[1].processes.map((process) => [process.name, process.pid, process.user]), [["sshd", "2222", "root"], ["systemd", "1", "root"]]);
});

test("lsof inspection retains process, username or UID and wildcard listener addresses", () => {
  const rows = "p1234\ncnode\nu1000\nLalice\nf8\nn127.0.0.1:3425\nf9\nn[::1]:3425\np2222\ncsshd\nu0\nf6\nn*:3425\n";
  const result = parseForwardConflict(wrap(rows.split("\n").filter(Boolean).map((line) => "LSOF\t" + line + "\n").join(""), "lsof"), 3425);
  assert.deepEqual(result.listeners.map((listener) => listener.address), ["127.0.0.1:3425", "[::1]:3425", "*:3425"]);
  assert.equal(result.listeners[0].processes[0].user, "alice");
  assert.equal(result.listeners[2].processes[0].uid, "0");
});

test("invalid, incomplete and wrong-port inspection results never identify an occupant", async () => {
  for (const stdout of ["private-command-output", wrap(sockets, "ss", 3426), wrap(sockets).replace("CONFLICT_END", "BROKEN"),
    wrap(sockets.replace(":3425", ":3426")), wrap(sockets.replace("127.0.0.1", "invalid-host")), wrap("arbitrary output\n"),
    wrap("SS\tLISTEN 0 128 127.0.0.1:3425 0.0.0.0:*\n", "unavailable")]) {
    assert.throws(() => parseForwardConflict(stdout, 3425));
    const message = await forwardRejectionMessage({}, forward, async () => ({ code: 0, stdout }));
    assert.match(message, /无法查询占用者/);
    assert.ok(!message.includes("private-command-output"));
  }
  for (const port of [0, -1, 65536, 1.5, "3425; arbitrary-command"]) assert.throws(() => forwardConflictScript(port));
});

test("rejection messages distinguish known owners, hidden processes and no visible listeners", async () => {
  const message = (stdout) => forwardRejectionMessage({}, forward, async () => ({ code: 0, stdout }));
  assert.match(await message(wrap(sockets + metadata)), /127\.0\.0\.1:3425.*node（PID 1234，用户 alice）/);
  const hidden = await message(wrap("SS\tLISTEN 0 128 0.0.0.0:3425 0.0.0.0:* uid:1000 ino:42\nUID\t1000\talice\n"));
  assert.match(hidden, /进程信息不可见，用户 alice.*无权查看/);
  assert.ok(!hidden.includes("PID 1000"));
  assert.match(await message(wrap(sockets + "UID\t1000\talice\n")), /PID 1234，用户 alice/);
  assert.match(await message(wrap()), /当前账户可见范围内未发现.*AllowTcpForwarding.*PermitListen/);
  assert.match(await message(wrap("", "unavailable")), /无法查询占用者/);
  const sanitized = await message(wrap(sockets + "PS\t1234 alice node\x1b[31m\x7f\n"));
  assert.ok(!/[\x00-\x1f\x7f]/.test(sanitized));
});

test("diagnostics use bounded SSH stdin requests and preserve failures without raw output", async () => {
  const controller = new AbortController();
  await forwardRejectionMessage({}, forward, async (_client, command, options) => {
    assert.equal(command, "sh -s");
    assert.equal(options.input, forwardConflictScript(3425));
    assert.equal(options.timeoutMs, 3000);
    assert.equal(options.maxBytes, 16384);
    assert.equal(options.signal, controller.signal);
    return { code: 0, stdout: wrap(sockets + metadata) };
  }, { signal: controller.signal });
  for (const execute of [async () => { throw new Error("private remote output"); }, async () => ({ code: 1, stdout: wrap(sockets + metadata) })]) {
    const message = await forwardRejectionMessage({}, forward, execute);
    assert.match(message, /无法查询占用者/);
    assert.ok(!message.includes("private remote output") && !message.includes("PID 1234"));
  }
  assert.match(await forwardRejectionMessage({}, { ...forward, bindPort: 0 }, () => assert.fail("No allocated port to inspect")), /未分配监听端口/);
});

function inspectRequests(fixture, respond) {
  fixture.server.on("connection", (client) => client.on("ready", () => client.on("session", (accept) => {
    const session = accept(); session.on("error", () => {});
    session.on("exec", (acceptExec, _rejectExec, { command }) => {
      const channel = acceptExec(); channel.on("error", () => {});
      if (command !== "sh -s") {
        const reply = fixture.listenerReply(command);
        assert.notEqual(reply, undefined);
        channel.resume(); channel.exit(0); channel.end(reply);
        return;
      }
      let input = "";
      channel.on("data", (chunk) => { input += chunk; });
      channel.on("end", () => respond(channel, input));
    });
  })));
}

function manager(t, options = {}) {
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" }, ...options });
  t.after(() => sessions.close());
  return sessions;
}

test("a real remote bind conflict reports its owner in the error, rule and logs while other forwards work", async (t) => {
  const fixture = await sshServer(t), blocker = await echoServer(t), echo = await echoServer(t);
  inspectRequests(fixture, (channel, input) => {
    assert.ok(input.includes(`port=${blocker.port}\n`));
    channel.exit(0); channel.end(wrap(sockets.replaceAll(":3425", ":" + blocker.port) + metadata, "ss", blocker.port));
  });
  const sessions = manager(t);
  await sessions.connect(fixture.profile);
  const working = await sessions.addForward(fixture.profile.id, { id: "working", direction: "c2s", bindPort: 0, targetPort: echo.port });
  await assert.rejects(sessions.addForward(fixture.profile.id, { id: "blocked", direction: "s2c", bindPort: blocker.port, targetPort: echo.port }),
    (error) => error.code === "FORWARD_REJECTED" && /node（PID 1234，用户 alice）/.test(error.message));
  const status = sessions.status(fixture.profile.id);
  assert.equal(status.state, "connected");
  assert.match(status.forwardErrors[0].message, /PID 1234/);
  assert.ok(status.logs.some((entry) => entry.level === "error" && /PID 1234/.test(entry.message)));
  assert.equal((await exchange(working.bindPort)).toString(), "SSH tunnel round trip");
  assert.equal((await exchange(blocker.port)).toString(), "SSH tunnel round trip");
  await new Promise((resolve) => blocker.server.close(resolve));
  const retried = await sessions.addForward(fixture.profile.id, { id: "blocked", direction: "s2c", bindPort: blocker.port, targetPort: echo.port });
  assert.equal((await exchange(retried.bindPort)).toString(), "SSH tunnel round trip");
  assert.deepEqual(sessions.status(fixture.profile.id).forwardErrors, []);
});

for (const policy of ["continue", "rollback"]) {
  test(`owner diagnostics are retained during preset ${policy}`, async (t) => {
    const fixture = await sshServer(t, { rejectRemote: true });
    inspectRequests(fixture, (channel) => { channel.exit(0); channel.end(wrap(sockets + metadata)); });
    const sessions = manager(t);
    const pending = sessions.connect({ ...fixture.profile, forwardFailurePolicy: policy, forwards: [
      { id: "blocked", direction: "s2c", bindPort: 3425, targetPort: 80 },
      { id: "next", direction: "c2s", bindPort: 0, targetPort: 80 },
    ] });
    if (policy === "rollback") await assert.rejects(pending, (error) => error.code === "FORWARD_REJECTED" && /PID 1234/.test(error.message));
    else await pending;
    const status = sessions.status(fixture.profile.id);
    assert.match(status.forwardErrors[0].message, /PID 1234/);
    assert.equal(status.state, policy === "continue" ? "connected" : "failed");
    assert.deepEqual(status.forwards.map((item) => item.id), policy === "continue" ? ["next"] : []);
  });
}

test("a stalled inspection times out and leaves an explicit rejection and existing forward usable", async (t) => {
  const fixture = await sshServer(t, { rejectRemote: true }), echo = await echoServer(t);
  inspectRequests(fixture, () => {});
  const sessions = manager(t, { forwardTimeoutMs: 1000 });
  await sessions.connect(fixture.profile);
  const working = await sessions.addForward(fixture.profile.id, { id: "working", direction: "c2s", bindPort: 0, targetPort: echo.port });
  await assert.rejects(sessions.addForward(fixture.profile.id, { id: "blocked", direction: "s2c", bindPort: 3425, targetPort: echo.port }),
    (error) => error.code === "FORWARD_REJECTED" && /无法查询占用者/.test(error.message));
  assert.equal(sessions.status(fixture.profile.id).state, "connected");
  assert.ok((await exchange(working.bindPort)).length);
});

test("cancellation during owner inspection releases the session and preserves cancellation", async (t) => {
  const fixture = await sshServer(t, { rejectRemote: true });
  let inspecting = false;
  inspectRequests(fixture, () => { inspecting = true; });
  const sessions = manager(t), controller = new AbortController();
  await sessions.connect(fixture.profile);
  const pending = assert.rejects(sessions.addForward(fixture.profile.id, { id: "blocked", direction: "s2c", bindPort: 3425, targetPort: 80 },
    { signal: controller.signal }), { code: "OPERATION_CANCELLED" });
  await until(() => inspecting);
  controller.abort();
  await pending;
  assert.equal(sessions.status(fixture.profile.id).state, "failed");
  assert.deepEqual(sessions.status(fixture.profile.id).forwards, []);
});
