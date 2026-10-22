import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { get } from "node:http";
import { startManagementServer, publishEndpoint } from "../src/web-server.mjs";
import { createTools } from "../src/plugin.mjs";
import { ProfileStore } from "../src/store.mjs";
import { SessionManager } from "../src/sessions.mjs";
import { echoServer, exchange, sshServer, temporary } from "./helpers.mjs";

async function service(t) {
  const directory = await temporary(t);
  const store = new ProfileStore(join(directory, "connections.json"));
  const sessions = new SessionManager({ env: {} });
  const tools = createTools(store, sessions);
  const web = await startManagementServer({ tools });
  t.after(async () => { await web.close(); await sessions.close(); });
  const headers = { Authorization: `Bearer ${web.token}`, "Content-Type": "application/json", Origin: "null" };
  const call = async (method, args, credentials) => {
    const response = await fetch(new URL("api/call", web.url), { method: "POST", headers, body: JSON.stringify({ method, args, credentials }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    return body.result;
  };
  return { ...web, store, sessions, headers, call };
}

test("the management API permits the sandboxed page and refuses untrusted origins and unauthenticated calls", async (t) => {
  const web = await service(t);
  assert.equal((await fetch(new URL("api/snapshot", web.url))).status, 401);
  const own = await fetch(new URL("api/snapshot", web.url), { headers: web.headers });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("access-control-allow-origin"), "null");
  assert.deepEqual(await own.json(), { connections: [] });
  const foreign = await fetch(new URL("api/snapshot", web.url), { headers: { ...web.headers, Origin: "https://example.com" } });
  assert.equal(foreign.status, 403);
  const wrong = await fetch(new URL("api/snapshot", web.url), { headers: { ...web.headers, Authorization: "Bearer invalid" } });
  assert.equal(wrong.status, 401);
  const rebindingStatus = await new Promise((resolve, reject) => {
    get(new URL("api/snapshot", web.url), { headers: { ...web.headers, Host: "example.com" } }, (response) => {
      response.resume(); resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(rebindingStatus, 403);
  const preflight = await fetch(new URL("api/call", web.url), { method: "OPTIONS", headers: { Origin: "null", "Access-Control-Request-Headers": "authorization,content-type" } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers"), /Authorization/);
});

test("the management page is self-contained and only serves its declared assets", async (t) => {
  const web = await service(t);
  const response = await fetch(web.url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /连接服务器/);
  assert.match(response.headers.get("content-security-policy"), /sandbox allow-scripts/);
  assert.equal((await fetch(new URL("app.js", web.url))).status, 200);
  assert.equal((await fetch(new URL("src/store.mjs", web.url))).status, 404);
  assert.equal((await fetch(new URL("../package.json", web.url))).status, 404);
  assert.equal((await fetch(new URL("api/call", web.url), { method: "POST", headers: web.headers, body: "not JSON" })).status, 400);
  assert.equal((await fetch(new URL("api/call", web.url), { method: "POST", headers: web.headers, body: "x".repeat(70000) })).status, 413);
});

test("page actions authenticate with a transient password and persist, run and delete both forward directions", async (t) => {
  const fixture = await sshServer(t);
  const echo = await echoServer(t);
  const web = await service(t);
  const profile = { ...fixture.profile, passwordEnv: undefined };
  await web.call("save_connection", { connection: profile });
  await web.call("connect", { connectionId: profile.id }, { password: "local-test-secret" });
  assert.ok(!(await readFile(web.store.file, "utf8")).includes("local-test-secret"));
  for (const direction of ["c2s", "s2c"]) {
    const spec = { id: direction, direction, bindPort: 0, targetPort: echo.port };
    await web.call("forward_save", { connectionId: profile.id, forward: spec });
    assert.equal(web.sessions.status(profile.id).state, "connected");
    const forward = await web.call("forward_add", { connectionId: profile.id, forward: spec });
    assert.deepEqual(await exchange(forward.bindPort), Buffer.from("SSH tunnel round trip"));
    await assert.rejects(web.call("forward_save", { connectionId: profile.id, forward: spec }), /先停止/);
    await web.call("forward_delete", { connectionId: profile.id, forwardId: direction });
    assert.equal((await web.store.get(profile.id)).forwards.length, 0);
    await assert.rejects(exchange(forward.bindPort), /ECONNREFUSED/);
  }
  await web.call("disconnect", { connectionId: profile.id });
  await web.call("remove_connection", { connectionId: profile.id });
  assert.deepEqual(await web.store.list(), []);
});

test("the endpoint launcher is removed only by the host that published it", async (t) => {
  const file = join(await temporary(t), ".runtime", "endpoint.js");
  const remove = await publishEndpoint(file, "http://127.0.0.1:1234/first/");
  assert.match(await readFile(file, "utf8"), /first/);
  await writeFile(file, "newer-host");
  remove();
  assert.equal(await readFile(file, "utf8"), "newer-host");
  const removeLatest = await publishEndpoint(file, "http://127.0.0.1:1234/latest/");
  removeLatest();
  await assert.rejects(readFile(file), { code: "ENOENT" });
});
