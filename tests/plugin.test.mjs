import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createPlugin, createTools } from "../src/plugin.mjs";
import { ProfileStore } from "../src/store.mjs";
import { SessionManager } from "../src/sessions.mjs";
import plugin from "../index.mjs";
import { echoServer, exchange, sshServer, temporary } from "./helpers.mjs";

test("the package exposes a single OpenCode v1 plugin with JSON Schema tool arguments", async (t) => {
  const directory = await temporary(t);
  const hooks = await plugin.server({ directory }, { webUI: false });
  assert.deepEqual(Object.keys(hooks), ["tool"]);
  assert.equal(Object.keys(hooks.tool).length, 10);
  for (const tool of Object.values(hooks.tool)) {
    assert.equal(tool.args.type, "object");
    assert.equal(tool.args.additionalProperties, false);
    assert.equal(typeof tool.execute, "function");
  }
  assert.deepEqual(await hooks.tool.connections.execute({}), []);
  await hooks.tool.save_connection.execute({ connection: { id: "dev", host: "host.example", username: "dev" } });
  const reloaded = await createPlugin({ directory }, { webUI: false });
  assert.equal((await reloaded.tool.connections.execute({}))[0].connection.id, "dev");
});

test("Magpie tool workflow saves, connects, forwards, disconnects and removes a profile", async (t) => {
  const fixture = await sshServer(t);
  const echo = await echoServer(t);
  const store = new ProfileStore(join(await temporary(t), "connections.json"));
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  t.after(() => sessions.close());
  const tools = createTools(store, sessions);
  await tools.save_connection.execute({ connection: fixture.profile });
  await tools.connect.execute({ connectionId: fixture.profile.id });
  await assert.rejects(tools.remove_connection.execute({ connectionId: fixture.profile.id }), /断开/);
  await assert.rejects(tools.save_connection.execute({ connection: fixture.profile }), /断开/);
  for (const direction of ["c2s", "s2c"]) {
    const forward = await tools.forward_add.execute({
      connectionId: fixture.profile.id,
      forward: { id: direction, direction, bindPort: 0, targetPort: echo.port },
    });
    assert.deepEqual(await exchange(forward.bindPort), Buffer.from("SSH tunnel round trip"));
    await tools.forward_remove.execute({ connectionId: fixture.profile.id, forwardId: direction });
  }
  await tools.disconnect.execute({ connectionId: fixture.profile.id });
  await tools.remove_connection.execute({ connectionId: fixture.profile.id });
  assert.deepEqual(await tools.connections.execute({}), []);
});

test("disconnect also cancels a queued connect before it can create a session", async (t) => {
  const directory = await temporary(t);
  const sessions = new SessionManager();
  t.after(() => sessions.close());
  const tools = createTools(new ProfileStore(join(directory, "connections.json")), sessions);
  const save = tools.save_connection.execute({ connection: { id: "queued", host: "host.example", username: "dev" } });
  const connect = tools.connect.execute({ connectionId: "queued" });
  const cancelled = assert.rejects(connect, /取消/);
  await tools.disconnect.execute({ connectionId: "queued" });
  await save;
  await cancelled;
  assert.equal(sessions.status("queued").state, "disconnected");
});
