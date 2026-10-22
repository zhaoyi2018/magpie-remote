import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { validateForward } from "../src/config.mjs";
import { ProfileStore, profileRevision } from "../src/store.mjs";
import { SessionManager } from "../src/sessions.mjs";
import { createTools } from "../src/plugin.mjs";
import { echoServer, exchange, sshServer, temporary } from "./helpers.mjs";

test("forward display names survive reload while unnamed presets remain compatible", async (t) => {
  const file = join(await temporary(t), "connections.json");
  const store = new ProfileStore(file);
  const original = { id: "legacy", direction: "c2s", bindPort: 8081, targetPort: 8080 };
  const named = { ...original, id: "api", name: "本地 API 调试" };
  await store.save({ id: "dev", host: "host.example", username: "dev", forwards: [original, named] });
  const forwards = (await new ProfileStore(file).get("dev")).forwards;
  assert.equal(forwards[1].name, "本地 API 调试");
  assert.equal(Object.hasOwn(forwards[0], "name"), false);
  assert.deepEqual(forwards[0], validateForward(original));
  for (const name of ["", "   ", "invalid\nname", "x".repeat(101)]) {
    assert.throws(() => validateForward({ ...named, name }), /规则名称/);
  }
});

test("named presets and temporary forwards retain their names and transmit in both directions", async (t) => {
  const fixture = await sshServer(t);
  const echo = await echoServer(t);
  const store = new ProfileStore(join(await temporary(t), "connections.json"));
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  t.after(() => sessions.close());
  const tools = createTools(store, sessions);
  await tools.save_connection.execute({ connection: fixture.profile });
  for (const direction of ["c2s", "s2c"]) {
    const forward = { id: direction, name: `${direction} 中文规则`, direction, bindPort: 0, targetPort: echo.port };
    await tools.forward_save.execute({ connectionId: fixture.profile.id, forward, expectedRevision: profileRevision(await store.get(fixture.profile.id)) });
  }
  const connected = await tools.connect.execute({ connectionId: fixture.profile.id });
  for (const forward of connected.forwards) {
    assert.equal(forward.name, `${forward.direction} 中文规则`);
    assert.deepEqual(await exchange(forward.bindPort), Buffer.from("SSH tunnel round trip"));
    await tools.forward_remove.execute({ connectionId: fixture.profile.id, forwardId: forward.id });
  }
  for (const direction of ["c2s", "s2c"]) {
    const forward = await tools.forward_add.execute({
      connectionId: fixture.profile.id,
      forward: { id: `temporary-${direction}`, name: "临时调试", direction, bindPort: 0, targetPort: echo.port },
    });
    assert.equal(forward.name, "临时调试");
    assert.deepEqual(await exchange(forward.bindPort), Buffer.from("SSH tunnel round trip"));
    assert.equal((await store.get(fixture.profile.id)).forwards.some((item) => item.id === forward.id), false);
    await tools.forward_remove.execute({ connectionId: fixture.profile.id, forwardId: forward.id });
  }
});
