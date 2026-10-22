import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProfileStore } from "../src/store.mjs";
import { validateProfile, validateForward, pluginOptions } from "../src/config.mjs";
import { temporary } from "./helpers.mjs";

test("profiles survive reload and concurrent saves retain every connection", async (t) => {
  const file = join(await temporary(t), "connections.json");
  const store = new ProfileStore(file);
  assert.deepEqual(await store.list(), []);
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.save({ id: `host-${i}`, host: "host.example", username: "dev" })));
  const reloaded = new ProfileStore(file);
  assert.equal((await reloaded.list()).length, 8);
  await reloaded.save({ id: "host-0", name: "Updated", host: "host.example", username: "dev" });
  assert.equal((await reloaded.get("host-0")).name, "Updated");
  await reloaded.remove("host-0");
  await assert.rejects(reloaded.get("host-0"), /不存在/);
});

test("corrupt configuration is reported and never overwritten", async (t) => {
  const file = join(await temporary(t), "connections.json");
  await writeFile(file, "not JSON");
  const store = new ProfileStore(file);
  await assert.rejects(store.save({ id: "x", host: "host.example", username: "dev" }), /无法读取/);
  assert.equal(await readFile(file, "utf8"), "not JSON");
});

test("validation rejects secrets, relative key paths and invalid endpoints", () => {
  const base = { id: "x", host: "host.example", username: "dev" };
  assert.throws(() => validateProfile({ ...base, password: "must-not-be-persisted" }), /不支持字段/);
  assert.throws(() => validateProfile({ ...base, privateKey: "must-not-be-persisted" }), /不支持字段/);
  assert.throws(() => validateProfile({ ...base, identityFile: "relative/key" }), /绝对路径/);
  assert.throws(() => validateProfile({ ...base, port: 70000 }), /整数/);
  assert.throws(() => validateForward({ id: "x", direction: "upload", bindPort: 1234, targetPort: 80 }), /c2s/);
  assert.throws(() => validateForward({ id: "x", direction: "c2s", bindPort: 1234, targetPort: 0 }), /整数/);
  assert.throws(() => pluginOptions({}, { connectTimeoutMs: 55000 }), /整数/);
});
