import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import ssh2 from "ssh2";
import { executeRemote } from "../src/remote-exec.mjs";
import { SessionManager } from "../src/sessions.mjs";
import { hostPublicKey, sshServer, until } from "./helpers.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function executableServer(t, onExec) {
  const fixture = await sshServer(t);
  const requests = [];
  fixture.server.on("connection", (client) => {
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("error", () => {});
      session.on("pty", (_accept, reject) => {
        requests.push({ type: "pty" });
        reject?.();
      });
      session.on("exec", (acceptExec, reject, info) => {
        requests.push({ type: "exec", command: info.command });
        onExec({ accept: acceptExec, reject, command: info.command, client });
      });
    }));
  });
  return { ...fixture, requests };
}

async function connectedClient(t, fixture) {
  const client = new ssh2.Client();
  client.on("error", () => {});
  t.after(() => client.destroy());
  const ready = once(client, "ready");
  client.connect({
    host: fixture.profile.host, port: fixture.port, username: "tester",
    password: "local-test-secret", hostVerifier: (key) => key.equals(hostPublicKey),
  });
  await ready;
  return client;
}

function complete(channel, { code = 0, stdout = "", stderr = "" } = {}) {
  channel.on("error", () => {});
  channel.resume();
  if (stdout) channel.write(stdout);
  if (stderr) channel.stderr.write(stderr);
  channel.exit(code);
  channel.end();
}

test("real SSH exec preserves binary stdin, split UTF-8 on both streams, and a nonzero exit status without allocating a PTY", async (t) => {
  const input = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256));
  let received;
  const fixture = await executableServer(t, ({ accept }) => {
    const channel = accept();
    channel.on("error", () => {});
    const chunks = [];
    channel.on("data", (chunk) => chunks.push(chunk));
    channel.on("end", () => {
      received = Buffer.concat(chunks);
      for (const byte of Buffer.from("正常输出 𠮷\n")) channel.write(Buffer.from([byte]));
      for (const byte of Buffer.from("错误输出 é\n")) channel.stderr.write(Buffer.from([byte]));
      channel.exit(23);
      channel.end();
    });
  });
  const client = await connectedClient(t, fixture);
  assert.deepEqual(await executeRemote(client, "fixture-byte-exchange", { input }), {
    code: 23, stdout: "正常输出 𠮷\n", stderr: "错误输出 é\n",
  });
  assert.deepEqual(received, input);
  assert.deepEqual(fixture.requests, [{ type: "exec", command: "fixture-byte-exchange" }]);
});

test("real SSH stdout is delivered while the command is still running, without streaming stderr", async (t) => {
  const release = deferred(), output = deferred(), chunks = [];
  t.after(() => release.resolve());
  const fixture = await executableServer(t, ({ accept }) => {
    const channel = accept(); channel.on("error", () => {}); channel.resume();
    void (async () => {
      for (const byte of Buffer.from("下载 𠮷\n")) channel.write(Buffer.from([byte]));
      channel.stderr.write("private-diagnostic");
      await release.promise;
      channel.exit(0); channel.end("complete\n");
    })();
  });
  const client = await connectedClient(t, fixture);
  let completed = false;
  const task = executeRemote(client, "stream-progress", { onStdout(text) { chunks.push(text); if (chunks.join("").includes("下载 𠮷\n")) output.resolve(); } }).then((value) => { completed = true; return value; });
  await output.promise;
  assert.equal(completed, false);
  assert.equal(chunks.join(""), "下载 𠮷\n");
  release.resolve();
  assert.deepEqual(await task, { code: 0, stdout: "下载 𠮷\ncomplete\n", stderr: "private-diagnostic" });
  assert.equal(chunks.join(""), "下载 𠮷\ncomplete\n");
});

test("a real server refusing exec returns a transport error and leaves the SSH connection usable", async (t) => {
  const fixture = await executableServer(t, ({ accept, reject, command }) => {
    if (command === "refused") reject();
    else complete(accept(), { stdout: "still connected" });
  });
  const client = await connectedClient(t, fixture);
  await assert.rejects(executeRemote(client, "refused"), { code: "REMOTE_EXEC_FAILED" });
  assert.deepEqual(await executeRemote(client, "next"), { code: 0, stdout: "still connected", stderr: "" });
});

test("a timed out real exec closes its channel and allows a later command on the same SSH connection", async (t) => {
  let channelClosed = false;
  const entered = deferred();
  const fixture = await executableServer(t, ({ accept, command }) => {
    if (command !== "hang") return complete(accept(), { stdout: "next command" });
    const channel = accept();
    channel.on("error", () => {});
    channel.on("close", () => { channelClosed = true; });
    channel.resume();
    entered.resolve();
  });
  const client = await connectedClient(t, fixture);
  const pending = executeRemote(client, "hang", { timeoutMs: 300 });
  const rejected = assert.rejects(pending, { code: "REMOTE_TIMEOUT" });
  await entered.promise;
  await rejected;
  await until(() => channelClosed, "timed out SSH channel stayed open");
  assert.equal((await executeRemote(client, "next")).stdout, "next command");
});

test("aborting an active real exec closes the channel without disconnecting SSH", async (t) => {
  const entered = deferred();
  let channelClosed = false;
  const fixture = await executableServer(t, ({ accept, command }) => {
    if (command !== "hang") return complete(accept(), { stdout: "alive" });
    const channel = accept();
    channel.on("error", () => {});
    channel.on("close", () => { channelClosed = true; });
    channel.resume();
    entered.resolve();
  });
  const client = await connectedClient(t, fixture);
  const controller = new AbortController();
  const pending = executeRemote(client, "hang", { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: "REMOTE_CANCELLED" });
  await entered.promise;
  controller.abort();
  await rejected;
  await until(() => channelClosed, "cancelled SSH channel stayed open");
  assert.equal((await executeRemote(client, "next")).stdout, "alive");
});

test("combined real stdout and stderr exceeding the byte limit fails instead of returning truncated success", async (t) => {
  const fixture = await executableServer(t, ({ accept }) => {
    complete(accept(), { stdout: "a".repeat(40), stderr: "b".repeat(40) });
  });
  const client = await connectedClient(t, fixture);
  await assert.rejects(executeRemote(client, "large-output", { maxBytes: 64 }), { code: "REMOTE_OUTPUT_LIMIT" });
});

test("a real channel closing without an exit status is uncertain even when stdout contains the completion marker", async (t) => {
  const fixture = await executableServer(t, ({ accept }) => {
    const channel = accept();
    channel.on("error", () => {});
    channel.resume();
    channel.end("MIGPIE_DONE\n");
  });
  const client = await connectedClient(t, fixture);
  await assert.rejects(executeRemote(client, "missing-exit-status"), { code: "REMOTE_RESULT_UNKNOWN" });
});

test("a real remote exit signal cannot be mistaken for a successful numeric exit", async (t) => {
  const fixture = await executableServer(t, ({ accept }) => {
    const channel = accept();
    channel.on("error", () => {});
    channel.resume();
    channel.exit("TERM", false, "terminated by fixture");
    channel.end();
  });
  const client = await connectedClient(t, fixture);
  await assert.rejects(executeRemote(client, "signalled"), { code: "REMOTE_RESULT_UNKNOWN" });
});

test("losing the actual SSH transport while a command runs never reports a successful result", async (t) => {
  const fixture = await executableServer(t, ({ accept, client }) => {
    const channel = accept();
    channel.on("error", () => {});
    channel.resume();
    channel.on("end", () => client.end());
  });
  const client = await connectedClient(t, fixture);
  await assert.rejects(executeRemote(client, "disconnect"), (error) => {
    assert.ok(["REMOTE_DISCONNECTED", "REMOTE_RESULT_UNKNOWN"].includes(error.code), error.code);
    return true;
  });
});

test("an already aborted request never asks the transport to execute anything", async () => {
  const client = new EventEmitter();
  let execCalls = 0;
  client.exec = () => { execCalls++; };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executeRemote(client, "must-not-execute", { signal: controller.signal }), { code: "REMOTE_CANCELLED" });
  assert.equal(execCalls, 0);
  assert.equal(client.listenerCount("close"), 0);
});

test("a channel delivered after cancellation is destroyed and its late error is handled", async () => {
  const client = new EventEmitter();
  let callback;
  client.exec = (_command, _options, done) => { callback = done; };
  const controller = new AbortController();
  const rejected = assert.rejects(executeRemote(client, "late-channel", { signal: controller.signal }), { code: "REMOTE_CANCELLED" });
  controller.abort();
  await rejected;
  const channel = new EventEmitter();
  let destroyed = false;
  channel.destroy = () => { destroyed = true; };
  callback(undefined, channel);
  assert.equal(destroyed, true);
  assert.doesNotThrow(() => channel.emit("error", new Error("late channel failure")));
  assert.equal(client.listenerCount("close"), 0);
});

test("SessionManager.execute rejects disconnected profiles and carries a real exec on its authenticated connection", async (t) => {
  const fixture = await executableServer(t, ({ accept }) => complete(accept(), { stdout: "session exec" }));
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  t.after(() => sessions.close());
  await assert.rejects(async () => sessions.execute(fixture.profile.id, "before-connect"), { code: "REMOTE_NOT_CONNECTED" });
  await sessions.connect(fixture.profile);
  assert.deepEqual(await sessions.execute(fixture.profile.id, "through-session"), { code: 0, stdout: "session exec", stderr: "" });
  await sessions.disconnect(fixture.profile.id);
  await assert.rejects(async () => sessions.execute(fixture.profile.id, "after-disconnect"), { code: "REMOTE_NOT_CONNECTED" });
  assert.deepEqual(fixture.requests, [{ type: "exec", command: "through-session" }]);
});
