import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OperationError } from "../src/errors.mjs";
import { RemoteManager, parseProbe } from "../src/remote.mjs";
import { probeScript } from "../src/remote-scripts.mjs";
import { backupInventoryScript } from "../src/remote-backups.mjs";
import { ProfileStore, profileRevision } from "../src/store.mjs";
import { temporary, until } from "./helpers.mjs";

const baseProbe = {
  platform: "Linux", architecture: "x86_64", username: "tester", home: "/home/tester",
  container: "false", binary: "/home/tester/.local/bin/magpie", managedBinary: "/home/tester/.local/bin/magpie",
  version: "magpie 0.1.1500", binaryHash: "a".repeat(64), configDirectory: "/home/tester/.config/magpie",
  unit: "/home/tester/.config/systemd/user/magpie.service", unitHash: "b".repeat(64),
  installed: "true", systemd: "true", serviceInstalled: "true", serviceActive: "active",
  webEnabled: "true", webPort: "3430", webTLS: "false", linger: "yes", locked: "false",
  tools: "curl sha256sum base64 mktemp install readlink tar",
  capabilities: "update backup restore healthcheck daemon_install daemon_uninstall daemon_start daemon_stop daemon_restart daemon_web daemon_install_web",
};
const managementKey = "fixture-management-key-123456789";
const release = {
  version: "0.1.1501", sha256: "c".repeat(64),
  url: "https://github.com/yetone/magpie-releases/releases/download/v0.1.1501/magpie-cli-linux-amd64",
};
const success = () => ({ code: 0, stdout: "MIGPIE_DONE\n", stderr: "" });
const response = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr });

function probe(overrides = {}) {
  return "MIGPIE_REMOTE_V1\n" + Object.entries({ ...baseProbe, ...overrides })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => key + "\t" + Buffer.from(String(value)).toString("base64")).join("\n") + "\n";
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeSessions {
  state = "connected";
  fields = {};
  calls = [];
  forwards = [];
  added = [];
  removed = [];
  forgotten = [];
  logs = [];
  backupRows = [];
  onProbe;
  onAction;
  onReconcile;
  webResponse = response(`http://127.0.0.1:3430/?k=${managementKey}\n`);
  remoteState = "";

  status() { return { state: this.state, forwards: structuredClone(this.forwards) }; }

  async execute(id, command, options = {}) {
    const input = options.input;
    let kind;
    if (command === "sh -s" && input === probeScript) kind = "probe";
    else if (command === "sh -s" && input === backupInventoryScript) kind = "backups";
    else if (command === "sh -s" && /cat "\$base\/operations\/[a-f0-9-]+\/state"/.test(input ?? "")) kind = "reconcile";
    else if (/ daemon web$/.test(command)) kind = "web";
    else if (command === "sh -s" && input?.includes("MIGPIE_DONE")) kind = "action";
    else throw new Error("Unexpected fixture command: " + command);
    const call = { kind, id, command, ...options };
    this.calls.push(call);
    if (kind === "probe") return this.onProbe ? this.onProbe(call) : response(probe(this.fields));
    if (kind === "action") return this.onAction ? this.onAction(call) : success();
    if (kind === "backups") return response("MIGPIE_BACKUPS_V1\n" + this.backupRows.join("\n") + (this.backupRows.length ? "\n" : ""));
    if (kind === "reconcile") return this.onReconcile ? this.onReconcile(call) : response(this.remoteState + "\n");
    return this.webResponse;
  }

  async addForward(id, spec) {
    this.added.push({ id, ...spec });
    const forward = { ...spec, bindPort: 43125, state: "listening" };
    this.forwards.push(forward);
    return structuredClone(forward);
  }

  async removeForward(id, forwardId) { this.removed.push(forwardId); this.forwards = this.forwards.filter((item) => item.id !== forwardId); }
  forgetForward(id, forwardId) { this.forgotten.push(forwardId); }
  recordLog(id, level, message) { this.logs.push({ level, message }); }

  actions() { return this.calls.filter((call) => call.kind === "action"); }
}

async function fixture(t, fields = {}) {
  const directory = await temporary(t);
  const store = new ProfileStore(join(directory, "connections.json"));
  const profile = await store.save({ id: "server", host: "fixture.invalid", username: "tester" });
  const sessions = new FakeSessions();
  sessions.fields = fields;
  const releases = [];
  const options = { store, sessions, release: async (architecture) => { releases.push(architecture); return structuredClone(release); } };
  const remote = new RemoteManager(options);
  t.after(() => remote.close());
  return { directory, store, profile, sessions, releases, options, remote };
}

async function completed(h) {
  let operation;
  await until(async () => {
    operation = await h.remote.operation(h.profile.id);
    if (!operation || operation.state === "running") return false;
    const data = JSON.parse(await readFile(h.remote.file, "utf8"));
    return data.records.find((record) => record.connectionId === h.profile.id)?.operation?.state === operation.state;
  }, "remote operation did not finish and persist");
  return operation;
}

async function start(h, action = "restart") {
  const preview = await h.remote.preview(h.profile.id, action);
  const operation = await h.remote.apply(h.profile.id, action, preview.revision);
  return { preview, operation };
}

test("base64 probe retains version, Unicode paths and separate service and web facts", () => {
  const instance = parseProbe(probe({ home: "/home/测试 user's", webPort: "4567" }));
  assert.equal(instance.home, "/home/测试 user's");
  assert.equal(instance.version, "magpie 0.1.1500");
  assert.equal(instance.binaryHash, "a".repeat(64));
  assert.deepEqual(instance.service, { installed: true, state: "running" });
  assert.deepEqual(instance.web, { enabled: true, port: 4567, tls: false });
  assert.equal(instance.container, false);
  assert.ok(instance.tools.includes("sha256sum"));
});

test("probe rejects login banners, malformed fields, missing identity and control characters in paths", () => {
  const malformed = [
    "login banner\n" + probe(),
    probe().replace("MIGPIE_REMOTE_V1", "MIGPIE_REMOTE_V2"),
    probe() + "binary\t%%%not-base64%%%\n",
    probe() + "binary\tYQ==\textra\n",
    probe({ username: undefined }),
    probe({ home: "relative/home" }),
    probe({ binary: "/home/tester/magpie\n--evil" }),
  ];
  for (const stdout of malformed) assert.throws(() => parseProbe(stdout), { code: "REMOTE_PROTOCOL" });
});

test("an unreachable systemd user session is unavailable rather than a stopped service", () => {
  const instance = parseProbe(probe({ systemd: "false", serviceActive: "active" }));
  assert.deepEqual(instance.service, { installed: true, state: "unavailable" });
  assert.equal(parseProbe(probe({ serviceActive: "activating" })).service.state, "unknown");
});

for (const [name, fields, code] of [
  ["non-Linux server", { platform: "Darwin" }, "REMOTE_UNSUPPORTED"],
  ["container deployment", { container: "true" }, "REMOTE_UNSUPPORTED"],
  ["missing restart command", { capabilities: "update backup healthcheck" }, "REMOTE_CAPABILITY_UNSUPPORTED"],
  ["missing health check", { capabilities: "daemon_restart" }, "REMOTE_CAPABILITY_UNSUPPORTED"],
  ["missing checksum tool", { tools: "curl base64 mktemp install" }, "REMOTE_PREREQUISITE"],
  ["inaccessible user service", { systemd: "false" }, "REMOTE_NO_SYSTEMD"],
  ["transitioning user service", { serviceActive: "activating" }, "REMOTE_SERVICE_UNKNOWN"],
]) {
  test(`${name} rejects a management preview without sending a change`, async (t) => {
    const h = await fixture(t, fields);
    await assert.rejects(h.remote.preview(h.profile.id, "restart"), { code });
    assert.equal(h.sessions.actions().length, 0);
    assert.equal(await h.remote.operation(h.profile.id), null);
  });
}

test("version 0.1.1327 can update and enable its first service when its help advertises the required commands", async (t) => {
  const h = await fixture(t, { version: "magpie 0.1.1327", serviceInstalled: "false", serviceActive: "inactive", unitHash: "", webEnabled: "false" });
  const status = await h.remote.status(h.profile.id, { refresh: true });
  assert.equal(status.actions.update.enabled, true);
  assert.equal(status.actions.enable_web.enabled, true);
  assert.equal(status.actions.start.enabled, false);
  assert.equal(status.actions.start.code, "REMOTE_NO_SERVICE");
  await assert.rejects(h.remote.preview(h.profile.id, "start"), { code: "REMOTE_NO_SERVICE" });
  assert.equal((await h.remote.preview(h.profile.id, "enable_web")).action, "enable_web");
  await start(h, "update");
  assert.equal((await completed(h)).state, "succeeded");
});

test("an unrecognized version string does not disable commands confirmed by help", async (t) => {
  const h = await fixture(t, { version: "development build" });
  assert.equal((await h.remote.preview(h.profile.id, "restart")).action, "restart");
});

test("missing capabilities disable only dependent actions and explain the required command", async (t) => {
  const h = await fixture(t, { version: "magpie 0.1.1327", capabilities: "daemon_stop daemon_uninstall" });
  const status = await h.remote.status(h.profile.id, { refresh: true });
  assert.equal(status.actions.stop.enabled, true);
  assert.equal(status.actions.uninstall.enabled, true);
  assert.equal(status.actions.update.enabled, false);
  assert.match(status.actions.update.reason, /magpie update/);
  assert.equal(status.actions.enable_web.enabled, false);
  assert.equal(h.sessions.actions().length, 0);
});

test("legacy update without the official backup command uses an explicit archive preview and needs no passphrase", async (t) => {
  const h = await fixture(t, { version: "magpie 0.1.1327", capabilities: "update", serviceInstalled: "false", serviceActive: "inactive", unitHash: "" });
  const preview = await h.remote.preview(h.profile.id, "update");
  assert.equal(preview.backupMode, "archive");
  assert.equal(Object.hasOwn(preview, "requiresBackupPassphrase"), false);
  assert.ok(preview.warnings.some((warning) => warning.includes("未加密")));
  await h.remote.apply(h.profile.id, "update", preview.revision);
  assert.equal((await completed(h)).state, "succeeded");
  const action = h.sessions.actions()[0];
  assert.equal(action.command, "sh -s");
  assert.match(action.input, /config\.tar\.gz/);
  assert.ok(!action.input.includes("read -r passphrase"));
  assert.ok(action.input.indexOf("tar -czf") < action.input.indexOf('"$bin" update'));
});

test("legacy update refuses to proceed without a usable backup mechanism", async (t) => {
  const h = await fixture(t, { capabilities: "update", tools: "sha256sum", serviceInstalled: "false", serviceActive: "inactive", unitHash: "" });
  await assert.rejects(h.remote.preview(h.profile.id, "update"), { code: "REMOTE_PREREQUISITE" });
  assert.equal(h.sessions.actions().length, 0);
});

test("install preview resolves the injected release but does not download, execute an action or read a management key", async (t) => {
  const h = await fixture(t, { installed: "false", binary: "", version: "", binaryHash: "", serviceInstalled: "false", unitHash: "", webEnabled: "false" });
  const before = await readFile(h.store.file, "utf8");
  const preview = await h.remote.preview(h.profile.id, "install");
  assert.match(preview.revision, /^[a-f0-9]{64}$/);
  assert.ok(preview.changes.some((change) => change.includes(release.version)));
  assert.deepEqual(h.releases, ["x86_64"]);
  assert.deepEqual(h.sessions.calls.map((call) => call.kind), ["probe"]);
  assert.equal(await readFile(h.store.file, "utf8"), before);
  assert.equal(await h.remote.operation(h.profile.id), null);
});

test("caller supplied shell text is rejected as an action before any change is queued", async (t) => {
  const h = await fixture(t);
  await assert.rejects(h.remote.preview(h.profile.id, "restart; touch /tmp/unwanted"), { code: "REMOTE_ACTION_INVALID" });
  assert.equal(h.sessions.actions().length, 0);
});

for (const [name, changed] of [
  ["binary changed", { binaryHash: "d".repeat(64) }],
  ["service unit changed", { unitHash: "e".repeat(64) }],
  ["service stopped externally", { serviceActive: "inactive" }],
]) {
  test(`${name} after preview prevents the destructive command`, async (t) => {
    const h = await fixture(t);
    const preview = await h.remote.preview(h.profile.id, "restart");
    h.sessions.fields = changed;
    await h.remote.apply(h.profile.id, "restart", preview.revision);
    const operation = await completed(h);
    assert.equal(operation.state, "failed");
    assert.equal(operation.error.code, "REMOTE_PREVIEW_STALE");
    assert.equal(h.sessions.actions().length, 0);
  });
}

test("a saved profile edit invalidates an earlier preview without probing or changing the server", async (t) => {
  const h = await fixture(t);
  const preview = await h.remote.preview(h.profile.id, "restart");
  await h.store.save({ ...h.profile, name: "renamed after preview" }, { expectedRevision: profileRevision(h.profile) });
  const before = h.sessions.calls.length;
  await assert.rejects(h.remote.apply(h.profile.id, "restart", preview.revision), { code: "REMOTE_PREVIEW_STALE" });
  assert.equal(h.sessions.calls.length, before);
});

test("apply returns while the remote action is blocked, concurrent retries share an id, and competing operations are refused", async (t) => {
  const h = await fixture(t);
  const entered = deferred(), releaseAction = deferred();
  h.sessions.onAction = async () => { entered.resolve(); await releaseAction.promise; return success(); };
  t.after(() => releaseAction.resolve());
  const preview = await h.remote.preview(h.profile.id, "restart");
  const first = h.remote.apply(h.profile.id, "restart", preview.revision);
  const retry = h.remote.apply(h.profile.id, "restart", preview.revision);
  try {
    const [a, b] = await Promise.all([first, retry]);
    assert.equal(a.state, "running");
    assert.equal(b.id, a.id);
    await entered.promise;
    assert.equal(h.sessions.actions().length, 1);
    await assert.rejects(h.remote.apply(h.profile.id, "stop", "another-revision"), { code: "REMOTE_BUSY" });
    await assert.rejects(h.remote.preview(h.profile.id, "stop"), { code: "REMOTE_BUSY" });
    await assert.rejects(h.remote.status(h.profile.id, { refresh: true }), { code: "REMOTE_BUSY" });
    await assert.rejects(h.remote.forget(h.profile.id), { code: "REMOTE_BUSY" });
    await assert.rejects(h.remote.assertIdle(h.profile.id), { code: "REMOTE_BUSY" });
    assert.equal((await h.remote.operation(h.profile.id)).state, "running");
  } finally { releaseAction.resolve(); }
  const result = await completed(h);
  assert.equal(result.state, "succeeded");
  assert.equal((await h.remote.apply(h.profile.id, "restart", preview.revision)).id, result.id);
  assert.equal(h.sessions.actions().length, 1);
});

test("failure to persist the initial operation leaves no running record and executes nothing", async (t) => {
  const h = await fixture(t);
  const preview = await h.remote.preview(h.profile.id, "restart");
  const file = h.remote.file;
  const original = await readFile(file, "utf8");
  await rm(file);
  await mkdir(file);
  try {
    await assert.rejects(h.remote.apply(h.profile.id, "restart", preview.revision), { code: "REMOTE_STATE_WRITE_FAILED" });
    assert.equal(await h.remote.operation(h.profile.id), null);
    assert.equal(h.sessions.actions().length, 0);
    assert.deepEqual(h.sessions.calls.map((call) => call.kind), ["probe"]);
  } finally {
    await rm(file, { recursive: true });
    await writeFile(file, original);
  }
});

test("a disconnect during the preflight probe fails without creating an uncertain mutation", async (t) => {
  const h = await fixture(t);
  const preview = await h.remote.preview(h.profile.id, "restart");
  h.sessions.onProbe = () => { throw new OperationError("REMOTE_DISCONNECTED", "fixture disconnected during checking"); };
  await h.remote.apply(h.profile.id, "restart", preview.revision);
  const operation = await completed(h);
  assert.equal(operation.state, "failed");
  assert.equal(operation.error.code, "REMOTE_DISCONNECTED");
  assert.equal(h.sessions.actions().length, 0);
});

test("update always archives configuration without a passphrase even when official backup commands exist", async (t) => {
  const h = await fixture(t);
  const { preview } = await start(h, "update");
  const operation = await completed(h);
  assert.equal(operation.state, "succeeded");
  assert.equal(preview.backupMode, "archive");
  assert.equal(Object.hasOwn(preview, "requiresBackupPassphrase"), false);
  assert.equal(Object.hasOwn(preview, "passphraseMinimumLength"), false);
  assert.equal(h.sessions.actions().length, 1);
  const action = h.sessions.actions()[0];
  assert.equal(action.command, "sh -s");
  assert.match(action.input, /tar -czf/);
  assert.ok(!action.input.includes('"$bin" backup'));
  assert.ok(!action.input.includes("read -r passphrase"));
  assert.ok(action.input.indexOf("tar -czf") < action.input.indexOf('"$bin" update'));
  assert.equal(action.maxBytes, 65536);
  assert.match(operation.result.backupDirectory, /\/magpie-remote\/backups\/[a-f0-9-]+$/);
});

for (const action of ["backup", "update", "restore"]) {
  test(`${action} requires tar even when official backup and restore commands exist`, async (t) => {
    const h = await fixture(t, { tools: baseProbe.tools.replace(" tar", "") });
    await assert.rejects(h.remote.preview(h.profile.id, action), { code: "REMOTE_PREREQUISITE" });
    assert.equal(await h.remote.operation(h.profile.id), null);
    assert.equal(h.sessions.actions().length, 0);
  });
}

for (const [name, code, expectedCode] of [
  ["backup failed", 77, "REMOTE_ACTION_FAILED"],
  ["action script failed", 1, "REMOTE_ACTION_FAILED"],
  ["remote lock is occupied", 75, "REMOTE_BUSY"],
]) {
  test(`${name} remains failed even if stdout advertises success and never publishes secret output`, async (t) => {
    const h = await fixture(t);
    const passphrase = "private-backup-phrase-123456";
    h.sessions.onAction = () => response("MIGPIE_DONE\n" + passphrase, code, "diagnostic-secret " + passphrase);
    await start(h, "update");
    const operation = await completed(h);
    assert.equal(operation.state, "failed");
    assert.equal(operation.error.code, expectedCode);
    assert.equal(operation.result, undefined);
    for (const value of [JSON.stringify(operation), await readFile(h.remote.file, "utf8")]) {
      assert.ok(!value.includes(passphrase));
      assert.ok(!value.includes("diagnostic-secret"));
    }
    assert.equal(h.sessions.actions().length, 1);
  });
}

for (const [step, reason, backupReady, message] of [
  ["backing_up", "interactive", false, /备份配置失败.*尚未执行更新/],
  ["updating", "network", true, /执行官方更新失败.*网络、代理或证书/],
  ["restarting", "permission", true, /重启用户服务失败.*更新命令已完成/],
  ["healthcheck", "command_failed", true, /检查服务健康状态失败.*更新命令已完成/],
]) {
  test(`update failure preserves its ${step} stage, classified reason and completed backup without raw output`, async (t) => {
    const h = await fixture(t);
    const passphrase = "fixture-private-passphrase";
    h.sessions.onAction = async () => {
      const operation = await h.remote.operation(h.profile.id);
      return response(`untrusted-${passphrase}\nMIGPIE_RESULT_V1\t${operation.id}\t${step}\t1\t${reason}\t${backupReady}\n`, 1, "diagnostic-secret");
    };
    await start(h, "update");
    const operation = await completed(h);
    assert.equal(operation.state, "failed");
    assert.equal(operation.step, step);
    assert.deepEqual(operation.diagnostic, { step, exitCode: 1, reason });
    assert.match(operation.message, message);
    assert.equal(Boolean(operation.result?.backupDirectory), backupReady);
    assert.ok(!(await readFile(h.remote.file, "utf8")).includes(passphrase));
    assert.ok(!JSON.stringify(operation).includes("diagnostic-secret"));
  });
}

test("invalid or unrelated result markers cannot add remote text to a failure", async (t) => {
  for (const marker of [
    "MIGPIE_RESULT_V1\twrong-id\tupdating\t1\tnetwork\ttrue",
    "MIGPIE_RESULT_V1\t{id}\tupdating\t2\tnetwork\ttrue",
    "MIGPIE_RESULT_V1\t{id}\tsecret-step\t1\tnetwork\ttrue",
    "MIGPIE_RESULT_V1\t{id}\tupdating\t1\tsecret-reason\ttrue",
    "MIGPIE_RESULT_V1\t{id}\tcompleted\t1\tnetwork\ttrue",
    "MIGPIE_RESULT_V1\t{id}\tupdating\t1\tnone\ttrue",
    "MIGPIE_RESULT_V1\t{id}\tupdating\t1\tnetwork\ttrue\nMIGPIE_RESULT_V1\t{id}\tupdating\t1\tnetwork\ttrue",
  ]) {
    const h = await fixture(t);
    h.sessions.onAction = async () => response(marker.replaceAll("{id}", (await h.remote.operation(h.profile.id)).id), 1);
    await start(h);
    const operation = await completed(h);
    assert.equal(operation.state, "failed");
    assert.equal(operation.diagnostic, undefined);
    assert.equal(operation.result, undefined);
    assert.ok(!JSON.stringify(operation).includes("secret-"));
  }
});

test("a success exit with contradictory structured evidence remains unknown", async (t) => {
  const h = await fixture(t);
  h.sessions.onAction = async () => response(`MIGPIE_DONE\nMIGPIE_RESULT_V1\t${(await h.remote.operation(h.profile.id)).id}\tupdating\t0\tnone\ttrue\n`);
  await start(h);
  assert.equal((await completed(h)).state, "unknown");
});

test("unknown update reconciliation restores the failure stage and backup from a matching result", async (t) => {
  const h = await fixture(t);
  h.sessions.onAction = () => { throw new OperationError("REMOTE_DISCONNECTED", "fixture lost connection"); };
  const { operation } = await start(h, "update");
  await completed(h);
  h.sessions.remoteState = `failed\nMIGPIE_RESULT_V1\t${operation.id}\tupdating\t1\tnetwork\ttrue`;
  const status = await h.remote.status(h.profile.id, { refresh: true });
  assert.equal(status.operation.state, "failed");
  assert.equal(status.operation.step, "updating");
  assert.match(status.operation.message, /网络、代理或证书/);
  assert.match(status.operation.result.backupDirectory, new RegExp(operation.id + "$"));
});

test("reconciliation keeps unknown when a structured result contradicts its state or belongs to another task", async (t) => {
  const h = await fixture(t);
  h.sessions.onAction = () => { throw new OperationError("REMOTE_DISCONNECTED", "fixture lost connection"); };
  const { operation } = await start(h);
  await completed(h);
  for (const state of [
    `succeeded\nMIGPIE_RESULT_V1\t${operation.id}\tupdating\t1\tnetwork\ttrue`,
    "failed\nMIGPIE_RESULT_V1\t00000000-0000-0000-0000-000000000000\tupdating\t1\tnetwork\ttrue",
    "succeeded\nunexpected-output",
  ]) {
    h.sessions.remoteState = state;
    assert.equal((await h.remote.status(h.profile.id, { refresh: true })).operation.state, "unknown");
  }
});

for (const [name, fields, shouldRestart] of [
  ["running", {}, true],
  ["stopped", { serviceActive: "inactive" }, false],
]) {
  test(`updating a ${name} service preserves its running intent`, async (t) => {
    const h = await fixture(t, fields);
    await start(h, "update");
    assert.equal((await completed(h)).state, "succeeded");
    assert.equal(h.sessions.actions()[0].input.includes('"$bin" daemon restart'), shouldRestart);
  });
}

for (const [name, actionResult, expectedCode] of [
  ["lost connection", () => { throw new OperationError("REMOTE_DISCONNECTED", "fixture lost connection"); }, "REMOTE_DISCONNECTED"],
  ["timeout", () => { throw new OperationError("REMOTE_TIMEOUT", "fixture timeout"); }, "REMOTE_TIMEOUT"],
  ["missing completion marker", () => response("partial output\n"), "REMOTE_RESULT_UNKNOWN"],
]) {
  test(`${name} after dispatch persists unknown and blocks a second mutation across manager restart`, async (t) => {
    const h = await fixture(t);
    h.sessions.onAction = actionResult;
    const { preview } = await start(h);
    const unknown = await completed(h);
    assert.equal(unknown.state, "unknown");
    assert.equal(unknown.error.code, expectedCode);
    await h.remote.close();
    const reloaded = new RemoteManager(h.options);
    t.after(() => reloaded.close());
    assert.equal((await reloaded.operation(h.profile.id)).state, "unknown");
    await assert.rejects(reloaded.preview(h.profile.id, "restart"), { code: "REMOTE_BUSY" });
    await assert.rejects(reloaded.apply(h.profile.id, "restart", "new-revision"), { code: "REMOTE_BUSY" });
    await assert.rejects(reloaded.forget(h.profile.id), { code: "REMOTE_BUSY" });
    assert.equal((await reloaded.apply(h.profile.id, "restart", preview.revision)).id, unknown.id);
    assert.equal(h.sessions.actions().length, 1);
  });
}

test("restarting with a persisted running operation restores unknown and requires a matching remote completion record", async (t) => {
  const h = await fixture(t);
  const entered = deferred(), releaseAction = deferred();
  h.sessions.onAction = async () => { entered.resolve(); await releaseAction.promise; return success(); };
  const { operation } = await start(h);
  await entered.promise;
  const restarted = new RemoteManager(h.options);
  t.after(() => restarted.close());
  try {
    assert.equal((await restarted.operation(h.profile.id)).state, "unknown");
    const stillUnknown = await restarted.status(h.profile.id, { refresh: true });
    assert.equal(stillUnknown.instance.service.state, "running");
    assert.equal(stillUnknown.operation.state, "unknown");
    const reconcile = h.sessions.calls.find((call) => call.kind === "reconcile");
    assert.ok(reconcile.input.includes(`/operations/${operation.id}/state`));
    h.sessions.remoteState = "succeeded";
    h.sessions.fields = { locked: "true" };
    assert.equal((await restarted.status(h.profile.id, { refresh: true })).operation.state, "unknown");
    h.sessions.fields = { locked: "false" };
    const confirmed = await restarted.status(h.profile.id, { refresh: true });
    assert.equal(confirmed.operation.state, "succeeded");
    assert.equal(h.sessions.actions().length, 1);
  } finally { releaseAction.resolve(); }
  await completed(h);
});

test("remote failure evidence wins over an apparently healthy service while reconciling an unknown operation", async (t) => {
  const h = await fixture(t);
  h.sessions.onAction = () => { throw new OperationError("REMOTE_DISCONNECTED", "fixture lost connection"); };
  await start(h);
  await completed(h);
  h.sessions.remoteState = "failed";
  const status = await h.remote.status(h.profile.id, { refresh: true });
  assert.equal(status.instance.service.state, "running");
  assert.equal(status.operation.state, "failed");
  assert.equal(h.sessions.actions().length, 1);
});

test("reconciliation ignores completion text from a failed state-read command", async (t) => {
  const h = await fixture(t);
  h.sessions.onAction = () => { throw new OperationError("REMOTE_DISCONNECTED", "fixture lost connection"); };
  await start(h);
  await completed(h);
  h.sessions.onReconcile = () => response("succeeded\n", 1, "state read failed");
  const status = await h.remote.status(h.profile.id, { refresh: true });
  assert.equal(status.operation.state, "unknown");
});

test("unknown operations permit credential recovery on the same endpoint but cannot be forgotten or rebound to another server", async (t) => {
  const h = await fixture(t);
  h.sessions.onAction = () => { throw new OperationError("REMOTE_DISCONNECTED", "fixture lost connection"); };
  await start(h);
  await completed(h);
  await h.remote.assertProfileChange({ ...h.profile, passwordEnv: "RECOVERED_PASSWORD" });
  await assert.rejects(h.remote.assertProfileChange({ ...h.profile, host: "different.invalid" }), { code: "REMOTE_BUSY" });
  await assert.rejects(h.remote.assertAllIdle(), { code: "REMOTE_BUSY" });
  await assert.rejects(h.remote.forget(h.profile.id), { code: "REMOTE_BUSY" });
});

test("a malformed persisted management file is preserved and never replaced by a fresh operation", async (t) => {
  const h = await fixture(t);
  await h.remote.close();
  const contents = "{broken remote management state";
  await writeFile(h.remote.file, contents);
  const reloaded = new RemoteManager(h.options);
  t.after(() => reloaded.close());
  await assert.rejects(reloaded.status(h.profile.id), { code: "REMOTE_STATE_INVALID" });
  await assert.rejects(reloaded.preview(h.profile.id, "restart"), { code: "REMOTE_STATE_INVALID" });
  assert.equal(await readFile(h.remote.file, "utf8"), contents);
  assert.equal(h.sessions.calls.length, 0);
});

test("a valid JSON file with a damaged operation state remains blocked and is not overwritten", async (t) => {
  const h = await fixture(t);
  h.sessions.onAction = () => { throw new OperationError("REMOTE_DISCONNECTED", "fixture lost connection"); };
  await start(h); await completed(h); await h.remote.close();
  const data = JSON.parse(await readFile(h.remote.file, "utf8"));
  data.records[0].operation.state = "runing";
  const contents = JSON.stringify(data);
  await writeFile(h.remote.file, contents);
  const reloaded = new RemoteManager(h.options);
  t.after(() => reloaded.close());
  await assert.rejects(reloaded.status(h.profile.id), { code: "REMOTE_STATE_INVALID" });
  await assert.rejects(reloaded.assertAllIdle(), { code: "REMOTE_STATE_INVALID" });
  assert.equal(await readFile(h.remote.file, "utf8"), contents);
  assert.equal(h.sessions.actions().length, 1);
});

test("uninstall refuses an externally managed binary path without issuing any action", async (t) => {
  const h = await fixture(t, { binary: "/usr/local/bin/magpie" });
  await assert.rejects(h.remote.preview(h.profile.id, "uninstall"), { code: "REMOTE_EXTERNAL_INSTALL" });
  assert.equal(h.sessions.actions().length, 0);
});

test("status and preview never fetch a management key; an explicit web request creates and reuses a loopback-only forward", async (t) => {
  const h = await fixture(t);
  await h.remote.status(h.profile.id, { refresh: true });
  await h.remote.preview(h.profile.id, "restart");
  assert.equal(h.sessions.calls.filter((call) => call.kind === "web").length, 0);
  h.sessions.webResponse = response(`\u001b[32mManagement: http://localhost:3430/?k=${managementKey}\u001b[0m\n`);
  const web = await h.remote.web(h.profile.id);
  assert.deepEqual(web, { address: "http://127.0.0.1:43125/", url: `http://127.0.0.1:43125/?k=${managementKey}` });
  assert.deepEqual(h.sessions.added, [{
    id: "magpie-web", name: "远程 Magpie 管理", direction: "c2s", bindHost: "127.0.0.1", bindPort: 0,
    targetHost: "127.0.0.1", targetPort: 3430,
  }]);
  assert.equal((await h.remote.web(h.profile.id)).url, web.url);
  assert.equal(h.sessions.added.length, 1);
  assert.ok(!(await readFile(h.remote.file, "utf8")).includes(managementKey));
  assert.ok(!JSON.stringify(await h.remote.status(h.profile.id)).includes(managementKey));
});

for (const [name, link] of [
  ["external hostname", `http://example.invalid:3430/?k=${managementKey}`],
  ["all-interface address", `http://0.0.0.0:3430/?k=${managementKey}`],
  ["deceptive localhost suffix", `http://localhost.evil.invalid:3430/?k=${managementKey}`],
  ["too-short key", "http://127.0.0.1:3430/?k=short"],
  ["non-root path", `http://127.0.0.1:3430/admin/?k=${managementKey}`],
]) {
  test(`explicit web request rejects a ${name} link without opening a forward`, async (t) => {
    const h = await fixture(t);
    h.sessions.webResponse = response(link);
    await assert.rejects(h.remote.web(h.profile.id), { code: "REMOTE_WEB_UNAVAILABLE" });
    assert.equal(h.sessions.added.length, 0);
  });
}

test("explicit web request rejects a failed key-read command even if it prints a valid-looking link", async (t) => {
  const h = await fixture(t);
  h.sessions.webResponse = response(`http://127.0.0.1:3430/?k=${managementKey}`, 1);
  await assert.rejects(h.remote.web(h.profile.id), { code: "REMOTE_WEB_UNAVAILABLE" });
  assert.equal(h.sessions.added.length, 0);
});

test("a caller's stale management port cannot redirect the tunnel to a different service", async (t) => {
  const h = await fixture(t);
  await assert.rejects(h.remote.web(h.profile.id, { port: 9999 }), { code: "REMOTE_WEB_PORT" });
  assert.equal(h.sessions.added.length, 0);
});

for (const [name, fields] of [
  ["disabled web", { webEnabled: "false" }],
  ["TLS web", { webTLS: "true" }],
]) {
  test(`${name} cannot retrieve a management key or open an HTTP forward`, async (t) => {
    const h = await fixture(t, fields);
    await assert.rejects(h.remote.web(h.profile.id), { code: "REMOTE_WEB_UNAVAILABLE" });
    assert.equal(h.sessions.calls.filter((call) => call.kind === "web").length, 0);
    assert.equal(h.sessions.added.length, 0);
  });
}

for (const [name, rule] of [
  ["public bind", { bindHost: "0.0.0.0" }],
  ["different destination", { targetHost: "example.invalid" }],
  ["different target port", { targetPort: 9999 }],
  ["reverse forward", { direction: "s2c" }],
]) {
  test(`a same-name ${name} forward cannot be reused for a management link`, async (t) => {
    const h = await fixture(t);
    h.sessions.forwards = [{ id: "magpie-web", direction: "c2s", bindHost: "127.0.0.1", bindPort: 43125, targetHost: "127.0.0.1", targetPort: 3430, ...rule }];
    const before = structuredClone(h.sessions.forwards);
    await assert.rejects(h.remote.web(h.profile.id), { code: "REMOTE_WEB_FORWARD" });
    assert.equal(h.sessions.added.length, 0);
    assert.deepEqual(h.sessions.forwards, before);
  });
}

for (const [version, state] of [["magpie 0.1.1500", "available"], ["v0.1.1501", "current"], ["magpie version 0.1.1502", "current"], ["development build", "unknown"]]) {
  test(`release comparison for ${version} reports ${state} and rejects redundant or unconfirmed updates`, async (t) => {
    const h = await fixture(t, { version });
    const status = await h.remote.status(h.profile.id, { refresh: true });
    assert.equal(status.update.state, state);
    assert.equal(status.actions.update.enabled, state === "available");
    if (state !== "available") {
      await assert.rejects(h.remote.preview(h.profile.id, "update"), { code: state === "current" ? "REMOTE_ALREADY_CURRENT" : "REMOTE_UPDATE_UNKNOWN" });
      assert.equal(h.sessions.actions().length, 0);
    }
    assert.equal(status.actions.restart.enabled, true);
  });
}

test("an unavailable release feed does not hide service controls or claim the current version is latest", async (t) => {
  const h = await fixture(t);
  h.remote.release = async () => { throw new OperationError("REMOTE_RELEASE_UNAVAILABLE", "fixture feed unavailable"); };
  const status = await h.remote.status(h.profile.id, { refresh: true });
  assert.equal(status.update.state, "unknown");
  assert.equal(status.update.error.code, "REMOTE_RELEASE_UNAVAILABLE");
  assert.equal(status.actions.update.enabled, false);
  assert.equal(status.actions.stop.enabled, true);
  assert.equal((await h.remote.preview(h.profile.id, "stop")).action, "stop");
});

const backupId = "3dba4545-7968-4d0d-91cc-eb06c5c1bb7f";
function backupRow(format = "archive", fingerprint = "f".repeat(64)) {
  return [backupId, format, "1234", "true", "1760000000", Buffer.from("magpie 0.1.1499").toString("base64"), fingerprint].join("\t");
}

test("remote backup inventory lists metadata without exposing backup contents and binds restores to the selected preview", async (t) => {
  const h = await fixture(t);
  h.sessions.backupRows = [backupRow()];
  const listing = await h.remote.backups(h.profile.id);
  assert.equal(listing.backups[0].format, "archive");
  assert.equal(listing.backups[0].hasBinary, true);
  assert.equal(listing.backups[0].size, 1234);
  assert.equal(listing.backups[0].version, "magpie 0.1.1499");
  const preview = await h.remote.preview(h.profile.id, "restore", { backupId });
  assert.equal(preview.backupId, backupId);
  assert.equal(Object.hasOwn(preview, "passphraseMinimumLength"), false);
  await h.remote.apply(h.profile.id, "restore", preview.revision);
  const operation = await completed(h);
  assert.equal(operation.state, "succeeded");
  const { command, input } = h.sessions.actions()[0];
  assert.equal(command, "sh -s");
  assert.ok(input.includes(backupId));
  assert.ok(input.indexOf("tar -czf") < input.indexOf('run_step stopping "$bin" daemon stop'));
  assert.ok(input.indexOf('run_step stopping "$bin" daemon stop') < input.indexOf('run_step restoring mv -- "$target"'));
  assert.ok(input.includes('run_step starting "$bin" daemon start'));
  assert.ok(!input.includes('"$bin" restore'));
  assert.ok(h.sessions.logs.some((entry) => entry.message.includes(operation.result.backupDirectory)));
});

test("creating a manual archive backup returns its directory without updating or restarting Magpie", async (t) => {
  const h = await fixture(t);
  const { preview } = await start(h, "backup");
  const operation = await completed(h);
  assert.equal(preview.action, "backup");
  assert.equal(operation.action, "backup");
  assert.equal(operation.state, "succeeded");
  assert.ok(operation.result.backupDirectory.endsWith(operation.id));
  const { command, input } = h.sessions.actions()[0];
  assert.equal(command, "sh -s");
  assert.ok(input.includes("tar -czf"));
  assert.ok(!input.includes('"$bin" update'));
  assert.ok(!input.includes('"$bin" daemon'));
  assert.ok(h.sessions.logs.every((entry) => !entry.message.includes("更新 Magpie")));
});

test("restoring a stopped archive needs no official backup, restore or service commands", async (t) => {
  const h = await fixture(t, { capabilities: "update", serviceActive: "inactive" });
  h.sessions.backupRows = [backupRow()];
  const preview = await h.remote.preview(h.profile.id, "restore", { backupId });
  await h.remote.apply(h.profile.id, "restore", preview.revision);
  assert.equal((await completed(h)).state, "succeeded");
  assert.ok(!h.sessions.actions()[0].input.includes('"$bin" daemon'));
});

test("a missing-config snapshot can restore an absent configuration with a pre-restore backup", async (t) => {
  const h = await fixture(t);
  h.sessions.backupRows = [backupRow("absent")];
  const preview = await h.remote.preview(h.profile.id, "restore", { backupId });
  assert.ok(preview.changes.some((change) => change.includes("无配置目录状态")));
  await h.remote.apply(h.profile.id, "restore", preview.revision);
  assert.match((await completed(h)).result.backupDirectory, /backups\//);
});

test("historical encrypted backups require manual restore but can be deleted after Magpie is uninstalled", async (t) => {
  const h = await fixture(t);
  h.sessions.backupRows = [backupRow("encrypted")];
  assert.equal((await h.remote.backups(h.profile.id)).backups[0].format, "encrypted");
  await assert.rejects(h.remote.preview(h.profile.id, "restore", { backupId }), { code: "REMOTE_BACKUP_FORMAT" });
  await assert.rejects(h.remote.preview(h.profile.id, "delete_backup", { backupId: "../../elsewhere" }), { code: "REMOTE_BACKUP_INVALID" });
  h.sessions.fields = { installed: "false", binary: "", version: "", binaryHash: "", serviceInstalled: "false", unitHash: "" };
  const preview = await h.remote.preview(h.profile.id, "delete_backup", { backupId });
  await h.remote.apply(h.profile.id, "delete_backup", preview.revision);
  assert.equal((await completed(h)).state, "succeeded");
  assert.match(h.sessions.actions()[0].input, /set_step deleting_backup/);
  assert.ok(!h.sessions.actions()[0].input.includes('rm -rf'));
});

for (const action of ["stop", "uninstall"]) {
  test(`successful ${action} closes only the managed Web tunnel and forgets its reconnect intent`, async (t) => {
    const h = await fixture(t);
    await h.remote.web(h.profile.id);
    h.sessions.forwards.push({ id: "independent", targetPort: 9000 });
    await start(h, action);
    assert.equal((await completed(h)).state, "succeeded");
    assert.deepEqual(h.sessions.removed, ["magpie-web"]);
    assert.deepEqual(h.sessions.forgotten, ["magpie-web"]);
    assert.deepEqual(h.sessions.forwards, [{ id: "independent", targetPort: 9000 }]);
  });
}

test("refreshing an externally stopped service closes the Web tunnel and refuses a new management link", async (t) => {
  const h = await fixture(t);
  await h.remote.web(h.profile.id);
  h.sessions.fields = { serviceActive: "inactive" };
  await h.remote.status(h.profile.id, { refresh: true });
  assert.deepEqual(h.sessions.removed, ["magpie-web"]);
  await assert.rejects(h.remote.web(h.profile.id), { code: "REMOTE_WEB_UNAVAILABLE" });
});

test("unknown stop retains its tunnel until remote completion evidence confirms it stopped", async (t) => {
  const h = await fixture(t);
  await h.remote.web(h.profile.id);
  h.sessions.onAction = () => { throw new OperationError("REMOTE_DISCONNECTED", "fixture disconnected"); };
  await start(h, "stop"); await completed(h);
  assert.deepEqual(h.sessions.removed, []);
  h.sessions.remoteState = "succeeded";
  await h.remote.status(h.profile.id, { refresh: true });
  assert.deepEqual(h.sessions.removed, ["magpie-web"]);
  const before = h.sessions.logs.length;
  await h.remote.status(h.profile.id);
  assert.equal(h.sessions.logs.length, before);
});

test("a failed remote update emits one error into runtime logs without leaking stdout or the backup phrase", async (t) => {
  const h = await fixture(t);
  const secret = "private-backup-phrase-1234";
  h.sessions.onAction = async () => response(`raw-secret-${secret}\nMIGPIE_RESULT_V1\t${(await h.remote.operation(h.profile.id)).id}\tupdating\t1\tnetwork\ttrue\n`, 1);
  await start(h, "update");
  const operation = await completed(h);
  assert.equal(h.sessions.logs.filter((entry) => entry.level === "error").length, 1);
  assert.ok(h.sessions.logs.find((entry) => entry.level === "error").message.includes(operation.result.backupDirectory));
  assert.ok(h.sessions.logs.some((entry) => entry.message.includes("执行官方更新失败")));
  assert.ok(!JSON.stringify(h.sessions.logs).includes(secret));
});
