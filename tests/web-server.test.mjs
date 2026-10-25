import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { get } from "node:http";
import { startManagementServer, publishEndpoint } from "../src/web-server.mjs";
import { createTools } from "../src/plugin.mjs";
import { ProfileStore, profileRevision } from "../src/store.mjs";
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
  assert.equal((await fetch(new URL("backups.js", web.url))).status, 200);
  assert.equal((await fetch(new URL("remote.js", web.url))).status, 200);
  assert.equal((await fetch(new URL("remote.css", web.url))).status, 200);
  assert.equal((await fetch(new URL("src/store.mjs", web.url))).status, 404);
  assert.equal((await fetch(new URL("../package.json", web.url))).status, 404);
  assert.equal((await fetch(new URL("api/call", web.url), { method: "POST", headers: web.headers, body: "not JSON" })).status, 400);
  assert.equal((await fetch(new URL("api/call", web.url), { method: "POST", headers: web.headers, body: "x".repeat(70000) })).status, 413);
});

test("authenticated backup recovery remains available when the normal snapshot is broken", async (t) => {
  const web = await service(t);
  await web.call("save_connection", { connection: { id: "recover", host: "host.example", username: "tester", autoReconnect: true } });
  const backup = await web.call("config_backup", {});
  const broken = "{ broken configuration";
  await writeFile(web.store.file, broken);
  const failed = await fetch(new URL("api/snapshot", web.url), { headers: web.headers });
  assert.equal(failed.status, 400);
  const error = await failed.json();
  assert.equal(error.code, "CONFIG_INVALID");
  assert.equal(error.category, "configuration");
  assert.equal(error.retryable, false);
  assert.equal((await web.call("config_backups", {}))[0].id, backup.id);
  const preview = await web.call("config_restore_preview", { backupId: backup.id });
  assert.equal(preview.currentValid, false);
  const denied = await fetch(new URL("api/call", web.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "config_restore", args: { backupId: backup.id, revision: preview.revision } }) });
  assert.equal(denied.status, 401);
  assert.equal(await readFile(web.store.file, "utf8"), broken);
  const result = await web.call("config_restore", { backupId: backup.id, revision: preview.revision, stopConnections: true });
  assert.equal(await readFile(result.preserved.recoveryFile, "utf8"), broken);
  const recovered = await fetch(new URL("api/snapshot", web.url), { headers: web.headers });
  assert.equal(recovered.status, 200);
  const row = (await recovered.json()).connections[0];
  assert.equal(row.connection.autoReconnect, true);
  assert.equal(row.session.state, "disconnected");
});

test("the page permits Magpie's Windows desktop origin without permitting arbitrary frame parents", async (t) => {
  const web = await service(t);
  const response = await fetch(web.url);
  const directive = response.headers.get("content-security-policy").split(";")
    .map((value) => value.trim()).find((value) => value.startsWith("frame-ancestors "));
  assert.ok(directive, "The management page must restrict its embedding origins");
  const origins = directive.split(/\s+/).slice(1);
  assert.ok(origins.includes("http://wails.localhost"), "Magpie's Windows desktop must be able to embed the page");
  assert.ok(origins.includes("http://127.0.0.1:*"));
  assert.ok(origins.includes("http://localhost:*"));
  assert.ok(origins.every((origin) => ["http://wails.localhost", "http://127.0.0.1:*", "http://localhost:*"].includes(origin)),
    "The fix must not permit unrelated websites to embed the page");
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
    await web.call("forward_save", { connectionId: profile.id, forward: spec, expectedRevision: profileRevision(await web.store.get(profile.id)) });
    assert.equal(web.sessions.status(profile.id).state, "connected");
    const forward = await web.call("forward_add", { connectionId: profile.id, forward: spec });
    assert.deepEqual(await exchange(forward.bindPort), Buffer.from("SSH tunnel round trip"));
    await assert.rejects(web.call("forward_save", { connectionId: profile.id, forward: spec, expectedRevision: profileRevision(await web.store.get(profile.id)) }), /先停止/);
    await web.call("forward_delete", { connectionId: profile.id, forwardId: direction, expectedRevision: profileRevision(await web.store.get(profile.id)) });
    assert.equal((await web.store.get(profile.id)).forwards.length, 0);
    await assert.rejects(exchange(forward.bindPort), /ECONNREFUSED/);
  }
  await web.call("disconnect", { connectionId: profile.id });
  await web.call("remove_connection", { connectionId: profile.id, expectedRevision: profileRevision(await web.store.get(profile.id)) });
  assert.deepEqual(await web.store.list(), []);
});

test("the authenticated page can preview a local SSH file and import only its selected host", async (t) => {
  const web = await service(t);
  const file = join(await temporary(t), "ssh-config");
  await writeFile(file, "Host selected unselected\n HostName server.example\n User developer\n");
  const preview = await web.call("ssh_config_preview", { configPath: file });
  assert.deepEqual(await web.store.list(), []);
  const result = await web.call("ssh_config_import", { configPath: file, revision: preview.revision, aliases: ["selected"] });
  assert.equal(result.imported.length, 1);
  assert.deepEqual((await web.store.list()).map((profile) => profile.id), ["selected"]);
  assert.equal(web.sessions.status("selected").state, "disconnected");
});

test("HTTP edits and MCP edits share revisions and conflicts preserve the newer configuration", async (t) => {
  const web = await service(t);
  const original = { id: "shared", name: "Original", host: "host.example", username: "dev" };
  const created = await web.call("save_connection", { connection: original, expectedRevision: null });
  assert.equal(created.connection.id, original.id);
  const response = await fetch(new URL("api/snapshot", web.url), { headers: web.headers });
  const { connections: [editing] } = await response.json();
  assert.equal(editing.revision, created.revision);
  const tools = createTools(web.store, web.sessions);
  const updated = await tools.save_connection.execute({ connection: { ...editing.connection, name: "Changed through MCP" }, expectedRevision: editing.revision });
  const conflict = await fetch(new URL("api/call", web.url), {
    method: "POST", headers: web.headers,
    body: JSON.stringify({ method: "save_connection", args: { connection: { ...editing.connection, host: "stale.example" }, expectedRevision: editing.revision } }),
  });
  assert.equal(conflict.status, 400);
  assert.equal((await conflict.json()).code, "CONFIG_CONFLICT");
  assert.equal((await web.store.get(original.id)).name, "Changed through MCP");
  const saved = await web.call("forward_save", { connectionId: original.id, forward: { id: "web", direction: "c2s", bindPort: 0, targetPort: 8080 }, expectedRevision: updated.revision });
  assert.equal(saved.forward.id, "web");
  assert.notEqual(saved.revision, updated.revision);
  await web.call("remove_connection", { connectionId: original.id, expectedRevision: saved.revision });
  assert.deepEqual(web.sessions.status(), []);
});

test("remote update credentials stay in the dedicated authenticated context and other methods reject them", async (t) => {
  const received = [];
  const result = { id: "fixture-operation", state: "running" };
  const remote = { async apply(id, action, revision, credentials) { received.push({ id, action, revision, credentials }); return result; } };
  const tools = createTools({}, {}, remote);
  const web = await startManagementServer({ tools });
  t.after(() => web.close());
  const args = { connectionId: "server", action: "update", revision: "a".repeat(64) };
  const credentials = { backupPassphrase: "fixture-backup-passphrase" };
  assert.deepEqual(await tools.remote_apply.execute(args, { credentials }), result);
  const request = (method, fields) => fetch(new URL("api/call", web.url), {
    method: "POST", headers: { Authorization: `Bearer ${web.token}`, "Content-Type": "application/json", Origin: "null" },
    body: JSON.stringify({ method, args, credentials: fields }),
  });
  const response = await request("remote_apply", credentials);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { result });
  assert.ok(!body.includes(credentials.backupPassphrase));
  assert.equal(received.length, 2);
  assert.deepEqual(received[0], received[1]);
  assert.deepEqual(received[1].credentials, credentials);
  for (const fields of [{ password: "wrong-field" }, { backupPassphrase: 123 }, { backupPassphrase: "x".repeat(4097) }]) {
    assert.equal((await request("remote_apply", fields)).status, 400);
  }
  assert.equal((await request("remote_preview", credentials)).status, 400);
  assert.equal((await request("remote_status", credentials)).status, 400);
  assert.equal(received.length, 2);
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
