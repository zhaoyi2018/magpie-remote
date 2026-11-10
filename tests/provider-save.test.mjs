import test from "node:test";
import assert from "node:assert/strict";
import { providerSaveRequest } from "../src/provider-save.mjs";

const target = { id: "local-magpie-fixture", mode: "direct", endpoint: "http://192.168.1.115:3425", key: "fixture-lan-key" };

test("a new automatic provider uses Add semantics and an empty model selection", () => {
  const body = providerSaveRequest(undefined, target);
  assert.equal(body.new, true); assert.equal(body.from, undefined);
  assert.equal(body.id, target.id); assert.equal(body.key, target.key);
  assert.equal(body.chat, target.endpoint + "/v1"); assert.equal(body.anthropic, target.endpoint);
  assert.deepEqual(body.models, []); assert.equal(body.proxy, "direct");
});

test("an existing provider becomes a typed update without view metadata or masked secrets", () => {
  const existing = { id: target.id, name: "My provider", key: { set: true, masked: "…old-key" },
    balanceToken: { takes: true, set: true }, testsAs: { agent: "fixture" }, keyList: [{ masked: "…other-key" }],
    ready: true, speaks: ["chat"], exposed: 2, host: "127.0.0.1", groups: {}, fetched: "recently",
    chosen: ["model-b", "model-unavailable"], models: [{ id: "model-a", on: true }, { id: "model-b", on: true }],
    proxy: "", maxConcurrency: null, maxAccounts: 2, queueLimit: 0, priceRate: 0, unlisted: false,
    fallback: ["backup"], contexts: { "*": 128000 }, headers: { "X-Custom": "fixture" },
    routing: "order", affinity: "strict", rateWindows: [{ seconds: 60, limit: 10 }] };
  const original = structuredClone(existing), body = providerSaveRequest(existing, target);
  assert.equal(body.new, false); assert.equal(body.from, existing.id); assert.equal(body.name, existing.name);
  assert.deepEqual(body.models, existing.chosen); assert.equal(body.key, target.key);
  for (const field of ["balanceToken", "testsAs", "keyList", "ready", "speaks", "exposed", "host", "groups", "fetched", "chosen"]) assert.equal(field in body, false, field);
  for (const field of ["proxy", "maxConcurrency", "maxAccounts", "queueLimit", "priceRate", "unlisted", "fallback", "contexts", "headers", "routing", "affinity", "rateWindows"]) assert.deepEqual(body[field], existing[field], field);
  body.contexts["*"] = 1; body.fallback.push("changed");
  assert.deepEqual(existing, original);
});

test("model projection preserves empty picks and supports older views without chosen", () => {
  assert.deepEqual(providerSaveRequest({ id: target.id, chosen: [], models: [{ id: "automatic", on: true }], noModels: true }, target).models, []);
  assert.deepEqual(providerSaveRequest({ id: target.id, models: [{ id: "picked", on: true }, { id: "unpicked", on: false }] }, target).models, ["picked"]);
  assert.deepEqual(providerSaveRequest({ id: target.id, models: ["legacy"] }, target).models, ["legacy"]);
  assert.equal("models" in providerSaveRequest({ id: target.id }, target), false);
});

test("unsupported model selections fail before constructing a destructive replacement", () => {
  for (const fields of [{ chosen: [{}] }, { models: {} }, { models: [{ name: "missing ID" }] }, { models: ["legacy", {}] }]) {
    assert.throws(() => providerSaveRequest({ id: target.id, ...fields }, target), { code: "PROVIDER_LINK_API" });
  }
});
