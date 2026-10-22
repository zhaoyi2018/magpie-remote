import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { readSSHConfig } from "../src/ssh-config.mjs";
import { ProfileStore } from "../src/store.mjs";
import { SessionManager } from "../src/sessions.mjs";
import { createTools } from "../src/plugin.mjs";
import { temporary } from "./helpers.mjs";

async function fixture(t, content) {
  const home = await temporary(t);
  await mkdir(join(home, ".ssh"));
  const configPath = join(home, ".ssh", "config");
  await writeFile(configPath, content);
  const options = { home, systemPath: join(home, "system_config"), username: "local-user", env: {} };
  return { home, configPath, options, read: () => readSSHConfig(options) };
}

test("SSH import reads aliases, quotes, equals, paths and TCP forward presets without reading key contents", async (t) => {
  const f = await fixture(t, `# comment\nHost dev dev.example\n HostName=192.0.2.10\n User developer\n Port = 2201\n IdentityFile "%d/.ssh/my key" # another comment\n UserKnownHostsFile "%d/.ssh/known_hosts"\n LocalForward 127.0.0.1:18080 127.0.0.1:8080\n RemoteForward [::1]:0 [2001:db8::1]:3425\nHost *\n User fallback\n Port 22\n`);
  await writeFile(join(f.home, ".ssh", "my key"), "PRIVATE KEY CONTENT MUST NOT APPEAR");
  const result = await f.read();
  assert.deepEqual(result.candidates.map((item) => item.alias), ["dev", "dev.example"]);
  const candidate = result.candidates[0];
  assert.equal(candidate.selectable, true);
  assert.equal(candidate.profile.username, "developer");
  assert.equal(candidate.profile.port, 2201);
  assert.equal(candidate.profile.host, "192.0.2.10");
  assert.equal(candidate.profile.identityFile.replaceAll("\\", "/"), `${f.home.replaceAll("\\", "/")}/.ssh/my key`);
  assert.deepEqual(candidate.profile.forwards.map(({ direction, bindHost, bindPort, targetHost, targetPort }) => ({ direction, bindHost, bindPort, targetHost, targetPort })), [
    { direction: "c2s", bindHost: "127.0.0.1", bindPort: 18080, targetHost: "127.0.0.1", targetPort: 8080 },
    { direction: "s2c", bindHost: "::1", bindPort: 0, targetHost: "2001:db8::1", targetPort: 3425 },
  ]);
  assert.ok(!JSON.stringify(result).includes("PRIVATE KEY CONTENT"));
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal((await f.read()).revision, result.revision);
});

test("SSH import applies first values, wildcard exclusions and user precedence over system defaults", async (t) => {
  const f = await fixture(t, `User initial\nHost *.prod !skip.prod\n Port 2222\nHost node.prod skip.prod\n User ignored-later-value\nHost *\n HostName %h.example\n`);
  await writeFile(f.options.systemPath, "User system\nPort 2200\n");
  const result = await f.read();
  const node = result.candidates.find((item) => item.alias === "node.prod");
  const skipped = result.candidates.find((item) => item.alias === "skip.prod");
  assert.equal(node.profile.username, "initial");
  assert.equal(node.profile.port, 2222);
  assert.equal(node.profile.host, "node.prod.example");
  assert.equal(skipped.profile.port, 2200);
  assert.equal(result.candidates.length, 2);
});

test("SSH Include expands globs in order and preserves conditional scope", async (t) => {
  const f = await fixture(t, `Include hosts/*.conf\nHost visible\n HostName visible.example\n Include conditional.conf\nHost second\n HostName second.example\nHost *\n User fallback\n`);
  await mkdir(join(f.home, ".ssh", "hosts"));
  await writeFile(join(f.home, ".ssh", "hosts", "02.conf"), "Host included\n Port 2222\n");
  await writeFile(join(f.home, ".ssh", "hosts", "01.conf"), "Host included\n Port 2201\n");
  await writeFile(join(f.home, ".ssh", "conditional.conf"), "Host unreachable\n User must-not-leak\n");
  const result = await f.read();
  assert.equal(result.candidates.find((item) => item.alias === "included").profile.port, 2201);
  assert.ok(!result.candidates.some((item) => item.alias === "unreachable"));
  assert.equal(result.candidates.find((item) => item.alias === "second").profile.username, "fallback");
  assert.equal(result.files.filter((file) => file.exists).length, 4);
});

test("SSH import identifies unsupported jump hosts and Match exec without running commands", async (t) => {
  const f = await fixture(t, `Host direct\n HostName direct.example\nHost jumped\n ProxyJump bastion\nHost exec-host\n HostName exec.example\nMatch host exec.example exec "echo never-run > marker"\n User dynamic\nHost *\n User fallback\n`);
  const result = await f.read();
  assert.equal(result.candidates.find((item) => item.alias === "direct").selectable, true);
  assert.equal(result.candidates.find((item) => item.alias === "jumped").selectable, false);
  const dynamic = result.candidates.find((item) => item.alias === "exec-host");
  assert.equal(dynamic.selectable, false);
  assert.match(dynamic.errors.join(" "), /Match/);
  await assert.rejects(access(join(f.home, "marker")));
});

test("SSH import detects Include cycles, malformed values and missing files without modifying them", async (t) => {
  const content = "Host cyclic\n Include loop.conf\nHost invalid\n Port nope\nHost broken\n IdentityFile \"unterminated\n";
  const f = await fixture(t, content);
  await writeFile(join(f.home, ".ssh", "loop.conf"), "Include config\n");
  const result = await f.read();
  assert.equal(result.candidates.find((item) => item.alias === "cyclic").selectable, false);
  assert.match(result.candidates.find((item) => item.alias === "cyclic").errors.join(" "), /循环/);
  assert.equal(result.candidates.find((item) => item.alias === "invalid").selectable, false);
  assert.equal(result.candidates.find((item) => item.alias === "broken").selectable, false);
  assert.ok(result.files.some((file) => !file.exists));
  assert.equal(await readFile(f.configPath, "utf8"), content);
});

test("SSH import expands environment and percent tokens and assigns stable IDs to dotted and non-Latin aliases", async (t) => {
  const f = await fixture(t, 'Host dev.example 中文服务器\n HostName %h\n IdentityFile "${KEY_DIRECTORY}/%n-%r"\n User developer\n');
  f.options.env.KEY_DIRECTORY = join(f.home, ".ssh");
  const result = await f.read();
  assert.equal(result.candidates.length, 2);
  for (const item of result.candidates) {
    assert.equal(item.selectable, true);
    assert.match(item.profile.id, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
    assert.ok(item.profile.identityFile.endsWith(`${item.alias}-developer`));
  }
  assert.notEqual(result.candidates[0].profile.id, result.candidates[1].profile.id);
  assert.deepEqual((await f.read()).candidates.map((item) => item.profile.id), result.candidates.map((item) => item.profile.id));
});

test("SSH preview and selective import preserve source files and skip existing profiles atomically", async (t) => {
  const f = await fixture(t, "Host first second\n HostName server.example\n User developer\n LocalForward 18080 127.0.0.1:8080\n");
  const file = join(f.home, "connections.json");
  const store = new ProfileStore(file);
  const sessions = new SessionManager({ env: {} });
  t.after(() => sessions.close());
  const tools = createTools(store, sessions);
  const preview = await tools.ssh_config_preview.execute({ configPath: f.configPath });
  await assert.rejects(access(file));
  assert.deepEqual(preview.candidates.map((item) => item.exists), [false, false]);
  const result = await tools.ssh_config_import.execute({ configPath: f.configPath, revision: preview.revision, aliases: ["second"], includeForwards: false });
  assert.deepEqual(result.imported.map((item) => item.id), ["second"]);
  assert.deepEqual((await store.get("second")).forwards, []);
  assert.equal(sessions.status("second").state, "disconnected");
  assert.equal((await store.list()).length, 1);
  await store.save({ id: "second", name: "Keep my changes", host: "existing.example", username: "existing" });
  const [a, b] = await Promise.all([0, 1].map(() => tools.ssh_config_import.execute({ configPath: f.configPath, revision: preview.revision, aliases: ["first", "second"] })));
  assert.equal(a.imported.length + b.imported.length, 1);
  assert.equal((await store.get("second")).name, "Keep my changes");
  assert.equal((await store.get("first")).forwards[0].direction, "c2s");
  assert.equal((await store.list()).length, 2);
  assert.equal((await tools.ssh_config_preview.execute({ configPath: f.configPath })).candidates.every((item) => item.exists), true);
  assert.match(await readFile(f.configPath, "utf8"), /Host first second/);
});

test("SSH import rejects stale previews and unsupported or unselected aliases before writing any profile", async (t) => {
  const f = await fixture(t, "Host allowed\n User developer\nHost jumped\n ProxyJump other\n");
  const store = new ProfileStore(join(f.home, "connections.json"));
  const sessions = new SessionManager({ env: {} });
  t.after(() => sessions.close());
  const tools = createTools(store, sessions);
  const preview = await tools.ssh_config_preview.execute({ configPath: f.configPath });
  await assert.rejects(tools.ssh_config_import.execute({ configPath: f.configPath, revision: preview.revision, aliases: ["allowed", "jumped"] }), /可导入/);
  await assert.rejects(tools.ssh_config_import.execute({ configPath: f.configPath, revision: preview.revision, aliases: ["missing"] }), /可导入/);
  assert.deepEqual(await store.list(), []);
  await writeFile(f.configPath, "Host allowed\n HostName changed.example\n User developer\n");
  await assert.rejects(tools.ssh_config_import.execute({ configPath: f.configPath, revision: preview.revision, aliases: ["allowed"] }), /已变化/);
  assert.deepEqual(await store.list(), []);
});

test("SSH import warns about unsupported forwarding while keeping the basic connection available", async (t) => {
  const f = await fixture(t, "Host basic\n User developer\n LocalForward /tmp/socket /tmp/remote\n DynamicForward 1080\n RemoteForward 23425 127.0.0.1:3425\n");
  const candidate = (await f.read()).candidates[0];
  assert.equal(candidate.selectable, true);
  assert.equal(candidate.profile.forwards.length, 1);
  assert.equal(candidate.profile.forwards[0].direction, "s2c");
  assert.match(candidate.warnings.join(" "), /localforward.*未导入/);
  assert.match(candidate.warnings.join(" "), /dynamicforward/);
});

test("SSH import deduplicates identical forwards and honors ClearAllForwardings", async (t) => {
  const f = await fixture(t, "Host repeated\n User developer\n LocalForward 18080 127.0.0.1:8080\n LocalForward 18080 127.0.0.1:8080\nHost cleared\n User developer\n ClearAllForwardings yes\n RemoteForward 23425 127.0.0.1:3425\n");
  const result = await f.read();
  assert.equal(result.candidates.find((item) => item.alias === "repeated").profile.forwards.length, 1);
  assert.deepEqual(result.candidates.find((item) => item.alias === "cleared").profile.forwards, []);
});
