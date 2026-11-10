import test from "node:test";
import assert from "node:assert/strict";
import { Agent, createServer, request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderLink } from "../src/provider-link.mjs";
import { localGateway } from "../src/local-gateway.mjs";
import { ProfileStore, profileRevision } from "../src/store.mjs";
import { SessionManager } from "../src/sessions.mjs";
import { OperationError } from "../src/errors.mjs";
import { listen, sshServer, temporary, until } from "./helpers.mjs";

const webKey = "fixture-web-sign-in-key-123456789";
const json = (response, value, code = 200) => { response.writeHead(code, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
const lanHost = Object.values(networkInterfaces()).flat().find((entry) => !entry.internal && entry.family === "IPv4" && /^(10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(entry.address))?.address;
const fakeInterfaces = { Ethernet: [{ address: "192.168.10.2", internal: false, family: "IPv4" }] };
const directAgent = new Agent({ keepAlive: false, proxyEnv: {} });
const directFetch = (url, { body, ...options } = {}) => new Promise((resolve, reject) => {
  const request = httpRequest(url, { ...options, agent: directAgent }, (response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      resolve({ status: response.statusCode, headers: new Headers(response.headers), text: async () => text, json: async () => JSON.parse(text) });
    })().catch(reject);
  });
  request.on("error", reject); request.end(body);
});

async function fixture(t, { lan = false, detection = false, reachable = lan } = {}) {
  assert.ok(lanHost, "The LAN integration fixture needs an assigned private IPv4 address");
  const directory = await temporary(t), ssh = await sshServer(t);
  const store = new ProfileStore(join(directory, "connections.json"));
  await store.save(ssh.profile);
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  t.after(() => sessions.close());
  await sessions.connect(ssh.profile);
  const gatewayCalls = [], providers = [], writes = [];
  const control = { loseSaveReply: false, running: true, busy: false, gatewayKey: randomBytes(24).toString("base64url"), detection, lan, reachable, webCalls: 0 };
  const gateway = createServer((request, response) => {
    gatewayCalls.push({ method: request.method, url: request.url, authorization: request.headers.authorization, host: request.headers.host, peer: request.socket.remoteAddress });
    if (request.headers.authorization !== "Bearer " + control.gatewayKey) return json(response, { error: "LAN gateway key required" }, 401);
    if (request.url === "/") return json(response, { name: "magpie", version: "0.1.3357" });
    if (request.url === "/v1/models") return json(response, { data: [{ id: "local/model-a", name: "本机模型 𠮷" }] });
    if (request.url === "/v1/chat/completions") {
      request.resume();
      request.on("end", () => { response.writeHead(200, { "Content-Type": "text/event-stream" }); response.end("data: fixture-stream\n\ndata: [DONE]\n\n"); });
      return;
    }
    json(response, { unexpected: true }, 404);
  });
  const gatewayPort = await listen(gateway, lanHost);
  t.after(() => { gateway.closeAllConnections(); return new Promise((resolve) => gateway.close(resolve)); });
  await writeFile(join(directory, "settings.json"), JSON.stringify({ lan: true, port: gatewayPort, lanKeyId: "lan-default" }));
  await writeFile(join(directory, "caller-keys.json"), JSON.stringify([{ id: "lan-default", lan: true, secret: control.gatewayKey }]));
  const admin = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (control.adminFailure?.method === request.method && control.adminFailure.path === url.pathname) return json(response, { error: "private-admin-error-output" }, control.adminFailure.status);
    if (url.pathname === "/" && url.searchParams.get("k") === webKey) {
      response.writeHead(303, { "Set-Cookie": "magpie_web_fixture=" + webKey + "; Path=/; HttpOnly", Location: "/" }); response.end(); return;
    }
    if (request.headers.cookie !== "magpie_web_fixture=" + webKey) return json(response, {}, 401);
    if (request.method === "GET" && url.pathname === "/api/providers") return json(response, { providers });
    if (request.method === "POST" && url.pathname === "/api/provider/save") {
      let input = "";
      request.on("data", (chunk) => { input += chunk; });
      request.on("end", () => {
        const value = JSON.parse(input); writes.push(value);
        const provider = { ...value, key: { set: true, masked: "…" + value.key.slice(-6) } };
        const index = providers.findIndex((entry) => entry.id === value.id);
        if (index < 0) providers.push(provider); else providers[index] = provider;
        if (control.loseSaveReply) { control.loseSaveReply = false; request.socket.destroy(); return; }
        json(response, { providers });
      });
      return;
    }
    json(response, {}, 404);
  });
  const adminPort = await listen(admin);
  t.after(() => { admin.closeAllConnections(); return new Promise((resolve) => admin.close(resolve)); });
  const remote = {
    async assertIdle() { if (control.busy) throw new OperationError("REMOTE_BUSY", "fixture busy"); },
    async inspect() { return { installed: true, locked: false, web: { enabled: true, tls: false }, service: { state: control.running ? "running" : "stopped" } }; },
    async managementLink() { return { address: `http://127.0.0.1:${adminPort}/`, url: `http://127.0.0.1:${adminPort}/?k=${webKey}` }; },
    async web() { control.webCalls++; return this.managementLink(); },
  };
  // The SSH fixture interprets only fixed probe/HTTP scripts. HTTP requests hit
  // actual temporary LAN/loopback listeners; no deployment command is executed.
  ssh.server.on("connection", (client) => client.on("ready", () => client.on("session", (accept) => {
    const session = accept(); session.on("error", () => {});
    session.on("exec", (acceptExec, _reject, { command }) => {
      const channel = acceptExec(); channel.on("error", () => {});
      let input = "";
      channel.on("data", (chunk) => { input += chunk; });
      channel.on("end", () => { void (async () => {
        const finish = (stdout, code = 0) => { channel.write(stdout); channel.exit(code); channel.end(); };
        const listener = ssh.listenerReply(command);
        if (listener !== undefined) return finish(listener);
        if (input.startsWith("# MIGPIE_LAN_NETWORK_V1")) {
          if (!control.detection) return finish("", 69);
          const hosts = [...input.matchAll(/route get '([^']+)'/g)].map((match) => match[1]);
          const remoteHost = control.lan ? lanHost : lanHost.startsWith("10.") ? "192.168.1.81" : "10.10.10.81";
          return finish("MIGPIE_LAN_NETWORK_V1\nssh\t" + Buffer.from(`${lanHost} 12345 ${remoteHost} 22`).toString("base64") + "\ncurl\ttrue\n" + hosts.map((host) => "route\t" + host + "\t" + Buffer.from(control.lan && host === lanHost ? host + " dev fixture src " + lanHost : host + " via 10.10.10.1 dev fixture src " + remoteHost).toString("base64")).join("\n") + "\n");
        }
        if (!input.startsWith("# MIGPIE_HTTP_V1")) return finish("", 70);
        const option = /(?<![\w-])(?:url|request|header|data) = ("(?:\\.|[^"\\])*")/g;
        let url, method = "GET", body; const headers = {};
        for (const match of input.matchAll(option)) {
          const value = JSON.parse(match[1]);
          if (match[0].startsWith("url")) url = value;
          else if (match[0].startsWith("request")) method = value;
          else if (match[0].startsWith("data")) body = value;
          else { const index = value.indexOf(":"); headers[value.slice(0, index)] = value.slice(index + 1).trim(); }
        }
        const address = new URL(url);
        assert.ok(address.hostname === "127.0.0.1" && Number(address.port) === adminPort || address.hostname === lanHost && Number(address.port) === gatewayPort);
        if (address.hostname === lanHost && !control.reachable) return finish("", 28);
        const response = await directFetch(url, { method, headers, ...(body !== undefined && { body }), signal: AbortSignal.timeout(3000) });
        finish("HTTP/1.1 " + response.status + " Fixture\r\n" + [...response.headers].map(([key, value]) => key + ": " + value + "\r\n").join("") + "\r\n" + await response.text(), response.status >= 400 ? 22 : 0);
      })().catch(() => { channel.exit(70); channel.end(); }); });
    });
  })));
  const options = { store, sessions, remote, directory, env: { MAGPIE_ADDR: `127.0.0.1:${gatewayPort}` } };
  const link = new ProviderLink(options);
  t.after(() => link.close());
  return { directory, store, sessions, ssh, profile: ssh.profile, providers, writes, gatewayCalls, gatewayHost: lanHost, gatewayPort, control, link, options };
}

test("gateway discovery uses LAN interfaces and the actual port instead of the host loopback address", async (t) => {
  const directory = await temporary(t);
  const discover = (env = {}, interfaces = fakeInterfaces) => localGateway(directory, env, { interfaces });
  await assert.rejects(discover(), { code: "LOCAL_MAGPIE_LAN_REQUIRED" });
  await writeFile(join(directory, "settings.json"), JSON.stringify({ lan: true, lanKey: "legacy-sharing-key" }));
  assert.equal((await discover()).url, "http://192.168.10.2:3425");
  await writeFile(join(directory, "settings.json"), JSON.stringify({ lan: true, port: 4567, lanKey: "legacy-sharing-key" }));
  assert.equal((await discover()).port, 4567);
  for (const host of ["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "[::]"]) assert.equal((await discover({ MAGPIE_ADDR: host + ":7654" })).url, "http://192.168.10.2:7654");
  assert.equal((await discover({ MAGPIE_ADDR: "192.168.10.2:7654" })).host, "192.168.10.2");
  assert.equal((await discover({ MAGPIE_PUBLIC_URL: "http://192.168.10.2:8765" })).port, 8765);
  const ipv6 = { Ethernet: [{ address: "fd12::1", internal: false, family: "IPv6" }] };
  assert.equal((await discover({ MAGPIE_ADDR: "[fd12::1]:7654" }, ipv6)).url, "http://[fd12::1]:7654");
  for (const address of ["http://remote.example:3425", "http://127.0.0.1:3425/api", "https://127.0.0.1:3425", "http://127.0.0.1:3425?key=bad"]) await assert.rejects(discover({ MAGPIE_ADDR: address }), { code: "LOCAL_MAGPIE_CONFIG" });
  await assert.rejects(discover({ MAGPIE_PUBLIC_URL: "http://127.0.0.1:3425" }), { code: "LOCAL_MAGPIE_CONFIG" });
  await assert.rejects(discover({}, { Tun: [{ address: "198.18.0.1", internal: false, family: "IPv4" }] }), { code: "LOCAL_MAGPIE_LAN_REQUIRED" });
});

for (const lan of [true, false]) {
test(`verified ${lan ? "on-link" : "routed cross-subnet"} LAN integration uses the actual gateway IP, shared key and no SSH port forwards`, async (t) => {
  const h = await fixture(t, { lan, detection: true, reachable: true });
  // Reconnect so the fixture's exec handler owns this authenticated client.
  await h.sessions.disconnect(h.profile.id); await h.sessions.connect(h.profile);
  const state = await h.link.sync(h.profile.id);
  assert.equal(state.state, "ready", JSON.stringify(state));
  assert.equal(state.mode, "direct");
  assert.equal(state.endpoint, `http://${h.gatewayHost}:${h.gatewayPort}`);
  assert.equal(h.control.webCalls, 0);
  assert.deepEqual(h.sessions.status(h.profile.id).forwards, []);
  const saved = h.writes[0]; assert.equal(saved.key, h.control.gatewayKey);
  const models = await directFetch(saved.chat + "/models", { headers: { Authorization: "Bearer " + saved.key } });
  assert.equal((await models.json()).data[0].id, "local/model-a");
  const stream = await directFetch(saved.chat + "/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + saved.key }, body: "{}" });
  assert.match(await stream.text(), /fixture-stream[\s\S]*\[DONE\]/);
  assert.equal((await h.link.sync(h.profile.id)).mode, "direct");
  assert.equal(h.writes.length, 1);
  const publicData = JSON.stringify([state, h.sessions.status(h.profile.id), JSON.parse(await readFile(h.link.file, "utf8"))]);
  for (const secret of [h.control.gatewayKey, webKey]) assert.ok(!publicData.includes(secret));
  await h.sessions.disconnect(h.profile.id);
  const disconnected = h.link.status(h.profile.id);
  assert.equal(disconnected.mode, "direct"); assert.equal(disconnected.state, "disconnected");
  assert.match(disconnected.message, /局域网供应商配置保留/);
  assert.equal((await directFetch(saved.chat + "/models", { headers: { Authorization: "Bearer " + saved.key } })).status, 200);
});
}

test("changing between LAN and SSH updates one owned provider and preserves unrelated forwards and settings", async (t) => {
  const h = await fixture(t, { detection: true }), id = h.profile.id;
  await h.sessions.disconnect(id); await h.sessions.connect(h.profile);
  const initial = await h.link.sync(id);
  assert.equal(initial.mode, "ssh", JSON.stringify(initial));
  assert.match(initial.message, /验证本机局域网网关.*curl 退出码 28/);
  const unrelated = await h.sessions.addForward(id, { id: "kept", direction: "c2s", bindPort: 0, targetPort: h.gatewayPort });
  h.providers[0].name = "My provider"; h.providers[0].priority = 7;
  h.control.reachable = true;
  const direct = await h.link.sync(id);
  assert.equal(direct.mode, "direct", JSON.stringify(direct));
  assert.equal(direct.providerId, initial.providerId);
  assert.equal(h.providers.length, 1); assert.equal(h.providers[0].name, "My provider"); assert.equal(h.providers[0].priority, 7);
  assert.deepEqual(h.sessions.status(id).forwards.map((forward) => forward.id), [unrelated.id]);
  h.control.reachable = false;
  const fallback = await h.link.sync(id);
  assert.equal(fallback.mode, "ssh", JSON.stringify(fallback));
  assert.equal(fallback.providerId, initial.providerId);
  assert.equal(fallback.endpoint, initial.endpoint);
  assert.equal(h.providers.length, 1);
  assert.equal((await fetch(fallback.endpoint + "/v1/models", { headers: { Authorization: "Bearer " + h.writes.at(-1).key } })).status, 200);
  h.control.reachable = true;
  assert.equal((await h.link.sync(id)).mode, "direct");
  assert.deepEqual(h.sessions.status(id).forwards.map((forward) => forward.id), [unrelated.id]);
  assert.equal(h.control.webCalls, 0);
});

for (const [path, method, phase] of [["/", "GET", "登录远端 Web 管理服务"], ["/api/providers", "GET", "读取远端供应商列表"], ["/api/provider/save", "POST", "保存远端供应商"]]) {
  test("verified direct access reports management failure during " + phase, async (t) => {
    const h = await fixture(t, { detection: true, reachable: true }), id = h.profile.id;
    h.control.adminFailure = { path, method, status: 401 };
    await h.sessions.disconnect(id); await h.sessions.connect(h.profile);
    const state = await h.link.sync(id);
    assert.equal(state.state, "error");
    assert.ok(state.message.startsWith("本机局域网网关直连验证已通过；"));
    assert.ok(state.message.includes(phase)); assert.ok(state.message.includes("HTTP 401"));
    assert.equal(state.mode, undefined, "A failed configuration must not be advertised as an active direct provider");
    assert.deepEqual(h.sessions.status(id).forwards, []);
    assert.equal(h.writes.length, 0); assert.equal(h.providers.length, 0);
    const publicData = JSON.stringify([state, h.sessions.status(id)]);
    for (const secret of [h.control.gatewayKey, webKey, "private-admin-error-output"]) assert.ok(!publicData.includes(secret));
    h.control.adminFailure = undefined;
    const recovered = await h.link.sync(id);
    assert.equal(recovered.mode, "direct"); assert.equal(recovered.state, "ready");
    assert.equal(h.writes.length, 1); assert.equal(h.providers.length, 1);
  });
}

test("a management failure preserves the old model tunnel until a successful direct cutover", async (t) => {
  const h = await fixture(t, { detection: true }), id = h.profile.id;
  await h.sessions.disconnect(id); await h.sessions.connect(h.profile);
  const first = await h.link.sync(id), original = h.sessions.status(id).forwards[0];
  h.control.reachable = true;
  h.control.adminFailure = { path: "/api/provider/save", method: "POST", status: 403 };
  const failed = await h.link.sync(id);
  assert.equal(failed.state, "error"); assert.match(failed.message, /直连验证已通过.*保存远端供应商.*HTTP 403/);
  assert.equal(h.sessions.status(id).forwards[0].bindPort, original.bindPort);
  assert.equal(h.providers[0].id, first.providerId); assert.equal(h.providers[0].anthropic, first.endpoint);
  assert.equal(h.writes.length, 1);
  h.control.adminFailure = undefined;
  const recovered = await h.link.sync(id);
  assert.equal(recovered.mode, "direct"); assert.equal(recovered.providerId, first.providerId);
  assert.deepEqual(h.sessions.status(id).forwards, []); assert.equal(h.providers.length, 1);
});

test("a lost transport-switch reply retains the old tunnel until readback confirms the direct provider", async (t) => {
  const h = await fixture(t, { detection: true }), id = h.profile.id;
  await h.sessions.disconnect(id); await h.sessions.connect(h.profile);
  assert.equal((await h.link.sync(id)).mode, "ssh");
  h.control.reachable = true; h.control.loseSaveReply = true;
  assert.equal((await h.link.sync(id)).state, "error");
  assert.ok(h.sessions.status(id).forwards.some((forward) => forward.id === "magpie-local-provider"));
  const writes = h.writes.length;
  assert.equal((await h.link.sync(id)).mode, "direct");
  assert.equal(h.writes.length, writes);
  assert.equal(h.providers.length, 1);
  assert.deepEqual(h.sessions.status(id).forwards, []);
});

test("LAN key rotation and plugin restart preserve provider identity without persisting the shared credential", async (t) => {
  const h = await fixture(t, { lan: true, detection: true }), id = h.profile.id;
  await h.sessions.disconnect(id); await h.sessions.connect(h.profile);
  const first = await h.link.sync(id), oldKey = h.control.gatewayKey;
  h.control.gatewayKey = randomBytes(24).toString("base64url");
  await writeFile(join(h.directory, "caller-keys.json"), JSON.stringify([{ id: "lan-default", lan: true, secret: h.control.gatewayKey }]));
  const rotated = await h.link.sync(id);
  assert.equal(rotated.mode, "direct", JSON.stringify(rotated)); assert.equal(rotated.providerId, first.providerId);
  assert.equal(h.writes.length, 2); assert.equal(h.writes.at(-1).key, h.control.gatewayKey);
  await h.link.close();
  const restarted = new ProviderLink(h.options); t.after(() => restarted.close());
  assert.equal((await restarted.sync(id)).mode, "direct");
  assert.equal(h.writes.length, 2);
  const contents = await readFile(h.link.file, "utf8");
  for (const secret of [oldKey, h.control.gatewayKey, webKey]) assert.ok(!contents.includes(secret));
  assert.deepEqual(h.sessions.status(id).forwards, []);
});

test("manual endpoint/key edits and a disabled LAN provider are preserved during automatic detection", async (t) => {
  const h = await fixture(t, { lan: true, detection: true }), id = h.profile.id;
  await h.sessions.disconnect(id); await h.sessions.connect(h.profile);
  assert.equal((await h.link.sync(id)).mode, "direct");
  const saved = structuredClone(h.providers[0]);
  h.providers[0].responses = "http://elsewhere.example/v1";
  assert.equal((await h.link.sync(id)).state, "error"); assert.equal(h.writes.length, 1);
  h.providers[0] = { ...saved, key: { set: true, masked: "…edited-key" } };
  assert.equal((await h.link.sync(id)).state, "error"); assert.equal(h.writes.length, 1);
  h.providers[0] = { ...saved, off: true };
  assert.equal((await h.link.sync(id)).state, "disabled"); assert.equal(h.writes.length, 1);
  assert.deepEqual(h.sessions.status(id).forwards, []);
});

test("legacy v1 tunnel records migrate to direct mode without changing provider identity", async (t) => {
  const h = await fixture(t, { detection: true }), id = h.profile.id;
  await h.sessions.disconnect(id); await h.sessions.connect(h.profile);
  const initial = await h.link.sync(id);
  assert.equal(initial.mode, "ssh");
  await h.link.close(); await h.sessions.disconnect(id);
  const data = JSON.parse(await readFile(h.link.file, "utf8"));
  data.version = 1; data.records = data.records.map(({ connectionId, binding, port }) => ({ connectionId, binding, port }));
  await writeFile(h.link.file, JSON.stringify(data));
  h.control.reachable = true; await h.sessions.connect(h.profile);
  const restarted = new ProviderLink(h.options); t.after(() => restarted.close());
  const next = await restarted.sync(id);
  assert.equal(next.mode, "direct", JSON.stringify(next)); assert.equal(next.providerId, initial.providerId);
  assert.equal(h.providers.length, 1); assert.deepEqual(h.sessions.status(id).forwards, []);
  assert.equal(JSON.parse(await readFile(h.link.file, "utf8")).version, 2);
});

test("a pending direct key rotation is reconciled after restart without a second provider write", async (t) => {
  const h = await fixture(t, { lan: true, detection: true }), id = h.profile.id;
  await h.sessions.disconnect(id); await h.sessions.connect(h.profile);
  assert.equal((await h.link.sync(id)).mode, "direct");
  h.control.gatewayKey = randomBytes(24).toString("base64url");
  await writeFile(join(h.directory, "caller-keys.json"), JSON.stringify([{ id: "lan-default", lan: true, secret: h.control.gatewayKey }]));
  h.control.loseSaveReply = true;
  assert.equal((await h.link.sync(id)).state, "error"); assert.equal(h.writes.length, 2);
  assert.equal(JSON.parse(await readFile(h.link.file, "utf8")).records[0].pending.mode, "direct");
  await h.link.close();
  const restarted = new ProviderLink(h.options); t.after(() => restarted.close());
  assert.equal((await restarted.sync(id)).mode, "direct"); assert.equal(h.writes.length, 2);
  assert.equal(JSON.parse(await readFile(h.link.file, "utf8")).records[0].pending, undefined);
});

test("verified direct access reuses a manual LAN provider and leaves manual reverse forwards untouched", async (t) => {
  const h = await fixture(t, { lan: true, detection: true }), id = h.profile.id;
  await h.sessions.disconnect(id); await h.sessions.connect(h.profile);
  const forward = await h.sessions.addForward(id, { id: "manual", direction: "s2c", bindPort: 0, targetHost: h.gatewayHost, targetPort: h.gatewayPort });
  h.providers.push({ id: "my-ssh", preset: "remote-magpie", chat: `http://127.0.0.1:${forward.bindPort}/v1` });
  const first = await h.link.sync(id);
  assert.equal(first.mode, "direct"); assert.notEqual(first.providerId, "my-ssh");
  assert.deepEqual(h.sessions.status(id).forwards.map((item) => item.id), [forward.id]);
  h.providers.splice(h.providers.findIndex((item) => item.id === first.providerId), 1);
  h.providers.push({ id: "my-lan", preset: "remote-magpie", chat: `http://${h.gatewayHost}:${h.gatewayPort}/v1`, name: "My LAN" });
  assert.equal((await h.link.sync(id)).providerId, "my-lan"); assert.equal(h.writes.length, 1);
  h.providers.at(-1).off = true;
  assert.equal((await h.link.sync(id)).state, "disabled"); assert.equal(h.writes.length, 1);
  assert.deepEqual(h.sessions.status(id).forwards.map((item) => item.id), [forward.id]);
});

test("a manually edited managed loopback port is not adopted as a legacy tunnel", async (t) => {
  const h = await fixture(t), id = h.profile.id;
  const first = await h.link.sync(id), otherPort = new URL(first.endpoint).port === "12345" ? 12346 : 12345;
  const edited = first.endpoint.replace(":" + new URL(first.endpoint).port + "/", ":" + otherPort + "/");
  Object.assign(h.providers[0], { chat: edited + "/v1", responses: edited + "/v1", anthropic: edited });
  assert.equal((await h.link.sync(id)).state, "error");
  assert.equal(h.providers[0].anthropic, edited); assert.equal(h.writes.length, 1);
  assert.equal(h.sessions.status(id).forwards[0].bindPort, Number(new URL(first.endpoint).port));
});

test("direct cutover preserves a same-ID forward whose target was manually replaced", async (t) => {
  const h = await fixture(t, { detection: true }), id = h.profile.id;
  await h.sessions.disconnect(id); await h.sessions.connect(h.profile);
  const first = await h.link.sync(id);
  assert.equal(first.mode, "ssh");
  const original = h.sessions.status(id).forwards[0];
  await h.sessions.removeForward(id, original.id);
  await h.sessions.addForward(id, { id: original.id, name: original.name, direction: "s2c", bindHost: original.bindHost, bindPort: original.bindPort, targetHost: "127.0.0.1", targetPort: h.gatewayPort });
  h.control.reachable = true;
  assert.equal((await h.link.sync(id)).mode, "direct");
  assert.equal(h.sessions.status(id).forwards[0].targetPort, h.gatewayPort);
  assert.equal(h.sessions.status(id).forwards[0].bindPort, original.bindPort);
});

test("LAN discovery respects the named sharing key and never falls back to a disabled or revoked key", async (t) => {
  const directory = await temporary(t), settings = { lan: true, lanKeyId: "default", lanKey: "stale-legacy-key" };
  const discover = () => localGateway(directory, {}, { interfaces: fakeInterfaces });
  await writeFile(join(directory, "settings.json"), JSON.stringify(settings));
  await assert.rejects(discover(), { code: "LOCAL_MAGPIE_KEY" });
  for (const caller of [{ id: "default", secret: "current-key", off: true }, { id: "other", secret: "other-key" }]) {
    await writeFile(join(directory, "caller-keys.json"), JSON.stringify([caller]));
    await assert.rejects(discover(), { code: "LOCAL_MAGPIE_KEY" });
  }
  await writeFile(join(directory, "caller-keys.json"), JSON.stringify([{ id: "default", secret: "current-key" }]));
  assert.equal((await discover()).key, "current-key");
  await writeFile(join(directory, "settings.json"), JSON.stringify({ ...settings, lan: false }));
  await assert.rejects(discover(), { code: "LOCAL_MAGPIE_LAN_REQUIRED" });
  await writeFile(join(directory, "caller-keys.json"), "[]");
  await writeFile(join(directory, "settings.json"), JSON.stringify({ lan: true, lanKey: "sk-magpie-revoked-old-key" }));
  await assert.rejects(discover(), { code: "LOCAL_MAGPIE_KEY" });
});

test("LAN probes, Web sign-in and model relays bypass a globally enabled environment proxy", async () => {
  const moduleURL = new URL("../src/local-gateway.mjs", import.meta.url).href;
  const script = `import assert from "node:assert/strict";
import { createServer } from "node:http";
import { magpieJSON, magpieSignIn, startProviderRelay } from ${JSON.stringify(moduleURL)};
const upstream = createServer((request, response) => {
  if (request.url.startsWith("/?k=")) { response.writeHead(303, { "Set-Cookie": "session=fixture-cookie", Location: "/" }); response.end(); return; }
  if (request.headers.authorization !== "Bearer lan-fixture-key") { response.writeHead(401).end(); return; }
  response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ name: "magpie", data: [{ id: "fixture-model" }] }));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + upstream.address().port;
let relay;
try {
  assert.equal((await magpieJSON(url, { headers: { Authorization: "Bearer lan-fixture-key" } })).name, "magpie");
  const signedIn = await magpieSignIn(url + "/?k=fixture");
  assert.equal(signedIn.status, 303); assert.deepEqual(signedIn.cookies, ["session=fixture-cookie"]);
  relay = await startProviderRelay(); relay.set("fixture", "relay-fixture-key", { url, key: "lan-fixture-key" });
  const models = await magpieJSON("http://127.0.0.1:" + relay.port + "/fixture/v1/models", { headers: { Authorization: "Bearer relay-fixture-key" } });
  assert.equal(models.data[0].id, "fixture-model");
  console.log("direct LAN transport passed");
} finally { await relay?.close(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); }
`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:1", https_proxy: "http://127.0.0.1:1", NO_PROXY: "", no_proxy: "" },
    timeout: 15000,
  });
  assert.equal(stdout.trim(), "direct LAN transport passed");
});

test("automatic integration adds one remote-magpie provider and serves models through a real reverse SSH tunnel", async (t) => {
  const h = await fixture(t), id = h.profile.id;
  const state = await h.link.sync(id);
  assert.equal(state.state, "ready", JSON.stringify(state));
  assert.equal(h.writes.length, 1);
  const saved = h.writes[0];
  assert.equal(saved.preset, "remote-magpie");
  assert.equal(saved.proxy, "direct");
  assert.equal(saved.chat, state.endpoint + "/v1");
  const forward = h.sessions.status(id).forwards.find((item) => item.id === "magpie-local-provider");
  assert.equal(forward.direction, "s2c"); assert.equal(forward.bindHost, "127.0.0.1");
  assert.equal(state.gatewayAddress, `http://${h.gatewayHost}:${h.gatewayPort}`);
  const response = await fetch(saved.chat + "/models", { headers: { "x-api-key": saved.key } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].name, "本机模型 𠮷");
  const stream = await fetch(saved.chat + "/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + saved.key, "Content-Type": "application/json" }, body: JSON.stringify({ model: "local/model-a", stream: true }) });
  assert.match(await stream.text(), /data: fixture-stream[\s\S]*\[DONE\]/);
  assert.equal(h.gatewayCalls.at(-1).authorization, "Bearer " + h.control.gatewayKey);
  assert.equal(h.gatewayCalls.at(-1).host, h.gatewayHost + ":" + h.gatewayPort);
  assert.equal(h.gatewayCalls.at(-1).peer, h.gatewayHost);
  assert.equal((await h.link.sync(id)).state, "ready");
  assert.equal(h.writes.length, 1, "Repeated detection must not add duplicate providers");
  const publicData = JSON.stringify([h.link.status(id), h.sessions.status(id).logs, JSON.parse(await readFile(h.link.file, "utf8"))]);
  for (const secret of [saved.key, webKey, h.control.gatewayKey]) assert.ok(!publicData.includes(secret));
});

test("the automatic tunnel refuses missing credentials and local administration routes", async (t) => {
  const h = await fixture(t);
  await h.link.sync(h.profile.id);
  const saved = h.writes[0], before = h.gatewayCalls.length;
  assert.equal((await fetch(saved.chat + "/models")).status, 401);
  for (const path of ["/api/providers", "/v1/magpie/keys", "/mcp/tools"]) {
    const response = await fetch(saved.anthropic + path, { headers: { "x-api-key": saved.key } });
    assert.equal(response.status, 403);
  }
  assert.equal(h.gatewayCalls.length, before);
});

test("reconnection and plugin restart reuse the saved remote port and supplier without storing its credential", async (t) => {
  const h = await fixture(t), id = h.profile.id;
  const first = await h.link.sync(id), secret = h.writes[0].key;
  await h.sessions.disconnect(id);
  assert.equal(h.link.status(id).state, "disconnected");
  await h.link.close();
  await h.sessions.connect(h.profile);
  const restarted = new ProviderLink(h.options); t.after(() => restarted.close());
  const next = await restarted.sync(id);
  assert.equal(next.state, "ready", JSON.stringify(next));
  assert.equal(next.endpoint, first.endpoint);
  assert.equal(h.writes.length, 1);
  assert.equal((await fetch(next.endpoint + "/v1/models", { headers: { "x-api-key": secret } })).status, 200);
});

test("a lost save reply is reconciled by reading providers before any retry", async (t) => {
  const h = await fixture(t); h.control.loseSaveReply = true;
  assert.equal((await h.link.sync(h.profile.id)).state, "error");
  assert.equal(h.writes.length, 1);
  assert.equal((await h.link.sync(h.profile.id)).state, "ready");
  assert.equal(h.writes.length, 1);
});

test("manual reverse forwarding and an existing local supplier are reused without creating a second supplier", async (t) => {
  const h = await fixture(t);
  const forward = await h.sessions.addForward(h.profile.id, { id: "manual-local", direction: "s2c", bindHost: "127.0.0.1", bindPort: 0, targetHost: h.gatewayHost, targetPort: h.gatewayPort });
  h.providers.push({ id: "my-local", preset: "remote-magpie", chat: `http://127.0.0.1:${forward.bindPort}/v1` });
  const state = await h.link.sync(h.profile.id);
  assert.equal(state.state, "ready"); assert.equal(state.providerId, "my-local");
  assert.equal(h.writes.length, 0);
  assert.equal(h.sessions.status(h.profile.id).forwards.length, 1);
});

test("an old localhost gateway forward is not reused as a LAN gateway", async (t) => {
  const h = await fixture(t);
  const legacy = await h.sessions.addForward(h.profile.id, { id: "legacy-loopback", direction: "s2c", bindPort: 0, targetHost: "127.0.0.1", targetPort: h.gatewayPort });
  h.providers.push({ id: "old-localhost", preset: "remote-magpie", chat: `http://127.0.0.1:${legacy.bindPort}/v1` });
  const state = await h.link.sync(h.profile.id);
  assert.equal(state.state, "ready", JSON.stringify(state));
  assert.notEqual(state.providerId, "old-localhost");
  assert.equal(state.gatewayAddress, `http://${h.gatewayHost}:${h.gatewayPort}`);
  assert.equal(h.writes.length, 1);
  assert.ok(h.sessions.status(h.profile.id).forwards.some((forward) => forward.id === legacy.id));
});

test("sharing key rotation updates the LAN relay without changing the remote supplier or its port", async (t) => {
  const h = await fixture(t), id = h.profile.id;
  const first = await h.link.sync(id), remoteKey = h.writes[0].key;
  h.control.gatewayKey = randomBytes(24).toString("base64url");
  await writeFile(join(h.directory, "caller-keys.json"), JSON.stringify([{ id: "lan-default", lan: true, secret: h.control.gatewayKey }]));
  const next = await h.link.sync(id);
  assert.equal(next.state, "ready", JSON.stringify(next));
  assert.equal(next.endpoint, first.endpoint);
  assert.equal(h.writes.length, 1);
  const response = await fetch(next.endpoint + "/v1/models", { headers: { Authorization: "Bearer " + remoteKey } });
  assert.equal(response.status, 200);
  assert.equal(h.gatewayCalls.at(-1).authorization, "Bearer " + h.control.gatewayKey);
  assert.ok(!JSON.stringify(h.link.status(id)).includes(h.control.gatewayKey));
});

test("turning LAN sharing off disables the old relay instead of falling back to localhost", async (t) => {
  const h = await fixture(t), id = h.profile.id;
  const first = await h.link.sync(id), remoteKey = h.writes[0].key;
  await writeFile(join(h.directory, "settings.json"), JSON.stringify({ lan: false, port: h.gatewayPort, lanKeyId: "lan-default" }));
  const callsBefore = h.gatewayCalls.length;
  const next = await h.link.sync(id);
  assert.equal(next.state, "error");
  assert.match(next.message, /局域网共享/);
  const response = await fetch(first.endpoint + "/v1/models", { headers: { Authorization: "Bearer " + remoteKey } });
  assert.equal(response.status, 401);
  assert.equal(h.gatewayCalls.length, callsBefore);
  assert.equal(h.writes.length, 1);
});

test("lifecycle operations, stopped services and disabled automation never write providers", async (t) => {
  const h = await fixture(t);
  h.control.busy = true;
  assert.equal((await h.link.sync(h.profile.id)).state, "waiting");
  h.control.busy = false; h.control.running = false;
  assert.equal((await h.link.sync(h.profile.id)).state, "waiting");
  await h.store.save({ ...h.profile, autoLinkLocalMagpie: false }, { expectedRevision: profileRevision(await h.store.get(h.profile.id)) });
  assert.equal((await h.link.sync(h.profile.id)).state, "disabled");
  assert.equal(h.writes.length, 0);
});

test("successful SSH authentication and network reconnection automatically restore the provider tunnel", async (t) => {
  const h = await fixture(t), id = h.profile.id;
  await h.sessions.disconnect(id);
  h.link.start((connectionId) => h.link.sync(connectionId));
  h.sessions.onConnected = (connectionId) => h.link.schedule(connectionId);
  h.sessions.reconnectDelayMs = 10; h.sessions.reconnectMaxDelayMs = 10; h.sessions.random = () => 0;
  await h.sessions.connect({ ...h.profile, autoReconnect: true });
  await until(() => h.link.status(id).state === "ready");
  const endpoint = h.link.status(id).endpoint, connectedAt = h.sessions.status(id).connectedAt;
  for (const client of h.ssh.clients) client.end();
  await until(() => h.sessions.status(id).state === "connected" && h.sessions.status(id).connectedAt !== connectedAt && h.sessions.status(id).forwards.some((item) => item.id === "magpie-local-provider"));
  await until(() => h.link.status(id).state === "ready");
  assert.equal(h.link.status(id).endpoint, endpoint);
  assert.equal(h.writes.length, 1);
});

test("a manually changed managed provider and a conflicting forward are preserved", async (t) => {
  const h = await fixture(t);
  await h.sessions.addForward(h.profile.id, { id: "magpie-local-provider", name: "my tunnel", direction: "s2c", bindHost: "127.0.0.1", bindPort: 0, targetHost: "127.0.0.1", targetPort: h.gatewayPort });
  assert.equal((await h.link.sync(h.profile.id)).state, "error");
  assert.equal(h.writes.length, 0);
  assert.equal(h.sessions.status(h.profile.id).forwards[0].name, "my tunnel");
  await h.sessions.removeForward(h.profile.id, "magpie-local-provider");
  await h.link.sync(h.profile.id);
  h.providers[0].chat = "http://elsewhere.example/v1";
  assert.equal((await h.link.sync(h.profile.id)).state, "error");
  assert.equal(h.providers[0].chat, "http://elsewhere.example/v1");
  assert.equal(h.writes.length, 1);
});

test("turning integration off closes only its managed reverse forward and preserves the supplier", async (t) => {
  const h = await fixture(t), id = h.profile.id;
  await h.link.sync(id);
  const unrelated = await h.sessions.addForward(id, { id: "unrelated", direction: "c2s", bindPort: 0, targetPort: h.gatewayPort });
  const profile = await h.store.get(id);
  await h.store.save({ ...profile, autoLinkLocalMagpie: false }, { expectedRevision: profileRevision(profile) });
  assert.equal((await h.link.sync(id)).state, "disabled");
  assert.deepEqual(h.sessions.status(id).forwards.map((forward) => forward.id), [unrelated.id]);
  assert.equal(h.providers.length, 1);
  assert.equal(h.writes.length, 1);
});

test("damaged integration state blocks writes and preserves the original data", async (t) => {
  const h = await fixture(t);
  await h.link.sync(h.profile.id); await h.link.close();
  const damaged = "{invalid-integration-state";
  await writeFile(h.link.file, damaged);
  const restarted = new ProviderLink(h.options); t.after(() => restarted.close());
  assert.equal((await restarted.sync(h.profile.id)).state, "error");
  assert.equal(await readFile(h.link.file, "utf8"), damaged);
  assert.equal(h.writes.length, 1);
});
