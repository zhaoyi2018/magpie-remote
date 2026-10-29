import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { closePlugin, createTools } from "../src/plugin.mjs";
import { ProfileStore, profileRevision } from "../src/store.mjs";
import { SessionManager } from "../src/sessions.mjs";
import plugin from "../index.mjs";
import { echoServer, exchange, sshServer, startPagePlugin, temporary } from "./helpers.mjs";

test("the package registers no tools or providers and retains saved connections", async (t) => {
  const directory = await temporary(t);
  const store = new ProfileStore(join(directory, "migpie-remote", "connections.json"));
  await store.save({ id: "dev", host: "host.example", username: "dev" });
  const { hooks, call } = await startPagePlugin(t, directory);
  assert.deepEqual(hooks, {});
  assert.equal((await call("connections"))[0].connection.id, "dev");
  const withoutPage = await plugin.server({ directory }, { webUI: false });
  t.after(() => closePlugin(withoutPage));
  assert.deepEqual(withoutPage, {});
});

test("page backend saves, connects, forwards, disconnects and removes a profile", async (t) => {
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
  await tools.remove_connection.execute({ connectionId: fixture.profile.id, expectedRevision: profileRevision(await store.get(fixture.profile.id)) });
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
