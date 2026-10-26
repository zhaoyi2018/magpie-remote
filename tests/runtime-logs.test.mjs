import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { SessionManager } from "../src/sessions.mjs";
import { ProfileStore } from "../src/store.mjs";
import { createTools } from "../src/plugin.mjs";
import { RemoteManager } from "../src/remote.mjs";
import { probeScript } from "../src/remote-scripts.mjs";
import { startManagementServer } from "../src/web-server.mjs";
import { echoServer, exchange, sshServer, temporary, until } from "./helpers.mjs";

test("management snapshots include real lifecycle logs across reconnects without persisting credentials", async (t) => {
  const fixture = await sshServer(t);
  const echo = await echoServer(t);
  const store = new ProfileStore(join(await temporary(t), "connections.json"));
  const sessions = new SessionManager({ env: {} });
  const tools = createTools(store, sessions);
  const web = await startManagementServer({ tools });
  t.after(async () => { await web.close(); await sessions.close(); });
  const profile = { ...fixture.profile, passwordEnv: undefined };
  await tools.save_connection.execute({ connection: profile });
  await tools.connect.execute({ connectionId: profile.id }, { credentials: { password: "local-test-secret" } });
  const rule = { id: "web", name: "本地开发代理", direction: "c2s", bindPort: 0, targetPort: echo.port };
  const forward = await tools.forward_add.execute({ connectionId: profile.id, forward: rule });
  assert.deepEqual(await exchange(forward.bindPort), Buffer.from("SSH tunnel round trip"));
  await tools.forward_remove.execute({ connectionId: profile.id, forwardId: rule.id });
  await tools.disconnect.execute({ connectionId: profile.id });
  const previous = sessions.status(profile.id);
  await assert.rejects(exchange(forward.bindPort), /ECONNREFUSED/);
  assert.ok(previous.logs.some((entry) => entry.message.includes("认证成功")));
  assert.ok(previous.logs.some((entry) => entry.message.includes("本地开发代理") && entry.message.includes("启动")));
  assert.ok(previous.logs.some((entry) => entry.message.includes("监听已释放")));
  assert.ok(previous.logs.some((entry) => entry.message.includes("SSH 连接已断开")));
  await tools.connect.execute({ connectionId: profile.id }, { credentials: { password: "local-test-secret" } });
  const response = await fetch(new URL("api/snapshot", web.url), { headers: { Authorization: "Bearer " + web.token } });
  const { connections: [row] } = await response.json();
  assert.ok(row.session.logs.length > previous.logs.length);
  assert.ok(row.session.logs.every((entry) => Number.isFinite(Date.parse(entry.time))));
  assert.equal(row.session.lastConnectedAt, row.session.connectedAt);
  assert.ok(!JSON.stringify(row).includes("local-test-secret"));
  assert.ok(!(await readFile(store.file, "utf8")).includes("local-test-secret"));
  assert.ok(!(await readFile(store.file, "utf8")).includes('"logs"'));
  row.session.logs[0].message = "must not modify live history";
  assert.notEqual(sessions.status(profile.id).logs[0].message, row.session.logs[0].message);
});

test("failed authentication and forwarding are recorded as errors and history remains bounded", async (t) => {
  const fixture = await sshServer(t);
  const echo = await echoServer(t);
  const sessions = new SessionManager({ env: {} });
  t.after(() => sessions.close());
  const profile = { ...fixture.profile, passwordEnv: undefined };
  await assert.rejects(sessions.connect(profile, { credentials: { password: "never-log-this" } }));
  let status = sessions.status(profile.id);
  assert.ok(status.logs.some((entry) => entry.level === "error" && entry.message.includes("SSH 连接失败")));
  assert.ok(!JSON.stringify(status.logs).includes("never-log-this"));
  await sessions.connect(profile, { credentials: { password: "local-test-secret" } });
  const spec = { id: "test", direction: "c2s", bindPort: 0, targetPort: echo.port };
  const first = await sessions.addForward(profile.id, spec);
  await assert.rejects(sessions.addForward(profile.id, { ...spec, id: "collision", bindPort: echo.port }));
  assert.ok(sessions.status(profile.id).logs.some((entry) => entry.level === "error" && entry.message.includes("collision")));
  await sessions.removeForward(profile.id, spec.id);
  for (let i = 0; i < 102; i++) {
    await sessions.addForward(profile.id, spec);
    await sessions.removeForward(profile.id, spec.id);
  }
  status = sessions.status(profile.id);
  assert.equal(status.logs.length, 200);
  assert.equal(status.state, "connected");
  const copy = sessions.status(profile.id);
  copy.logs[0].message = "changed";
  assert.notEqual(sessions.status(profile.id).logs[0].message, "changed");
  await sessions.disconnect(profile.id);
  assert.equal(sessions.status(profile.id).logs.length, 200);
});

test("remote service stop releases its actual Web listener, preserves SSH and unrelated forwards, and appears in runtime snapshots", async (t) => {
  const fixture = await sshServer(t), echo = await echoServer(t);
  const store = new ProfileStore(join(await temporary(t), "connections.json"));
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  let active = true;
  fixture.server.on("connection", (client) => client.on("ready", () => client.on("session", (accept) => {
    const channelSession = accept(); channelSession.on("error", () => {});
    channelSession.on("exec", (acceptExec, _reject, { command }) => {
      const channel = acceptExec(); channel.on("error", () => {});
      let input = "";
      channel.on("data", (chunk) => { input += chunk; });
      channel.on("end", () => {
        let output;
        if (input === probeScript) {
          const fields = { platform: "Linux", architecture: "x86_64", username: "tester", home: "/home/tester", binary: "/home/tester/.local/bin/magpie", managedBinary: "/home/tester/.local/bin/magpie", version: "magpie 0.1.1501", installed: true, binaryHash: "a".repeat(64), configDirectory: "/home/tester/.config/magpie", serviceInstalled: true, systemd: true, serviceActive: active ? "active" : "inactive", webEnabled: true, webPort: echo.port, capabilities: "daemon_stop daemon_web", tools: "sha256sum" };
          output = "MIGPIE_REMOTE_V1\n" + Object.entries(fields).map(([key, value]) => key + "\t" + Buffer.from(String(value)).toString("base64")).join("\n") + "\n";
        } else if (command.endsWith(" daemon web")) output = `http://127.0.0.1:${echo.port}/?k=runtime-test-management-key-123456\n`;
        else if (input.includes('"$bin" daemon stop')) { active = false; output = "MIGPIE_DONE\n"; }
        else { channel.exit(70); channel.end(); return; }
        channel.write(output); channel.exit(0); channel.end();
      });
    });
  })));
  const remote = new RemoteManager({ store, sessions });
  const tools = createTools(store, sessions, remote), web = await startManagementServer({ tools });
  t.after(async () => { await web.close(); await remote.close(); await sessions.close(); });
  await tools.save_connection.execute({ connection: { ...fixture.profile, autoReconnect: true } });
  await tools.connect.execute({ connectionId: fixture.profile.id });
  const independent = await sessions.addForward(fixture.profile.id, { id: "kept", direction: "c2s", bindPort: 0, targetPort: echo.port });
  const link = await remote.web(fixture.profile.id);
  const webPort = Number(new URL(link.address).port);
  assert.ok((await exchange(webPort)).length);
  const preview = await remote.preview(fixture.profile.id, "stop");
  await remote.apply(fixture.profile.id, "stop", preview.revision);
  await until(async () => (await remote.operation(fixture.profile.id)).state === "succeeded" && !sessions.status(fixture.profile.id).forwards.some((item) => item.id === "magpie-web"));
  await assert.rejects(exchange(webPort), /ECONNREFUSED/);
  assert.equal(sessions.status(fixture.profile.id).state, "connected");
  assert.ok((await exchange(independent.bindPort)).length);
  const response = await fetch(new URL("api/snapshot", web.url), { headers: { Authorization: "Bearer " + web.token } });
  const { connections: [row] } = await response.json();
  assert.ok(row.session.logs.some((entry) => entry.message.includes("远程 Magpie：停止服务") && entry.message.includes("已完成")));
  assert.ok(!JSON.stringify(row.session.logs).includes("runtime-test-management-key"));
  const connectedAt = sessions.status(fixture.profile.id).connectedAt;
  for (const client of fixture.clients) client.end();
  await until(() => sessions.status(fixture.profile.id).state === "connected" && sessions.status(fixture.profile.id).connectedAt !== connectedAt);
  assert.deepEqual(sessions.status(fixture.profile.id).forwards.map((forward) => forward.id), ["kept"]);
});
