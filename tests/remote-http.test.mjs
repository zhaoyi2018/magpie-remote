import test from "node:test";
import assert from "node:assert/strict";
import { remoteHTTP, remoteHTTPScript, remoteProviderAPI } from "../src/remote-http.mjs";

const key = "fixture-management-key-12345678";
const link = { url: "http://127.0.0.1:3430/?k=" + key };

test("HTTP transport parses informational replies, headerless responses and LF line endings", async () => {
  for (const [stdout, expected] of [
    ["HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}", { status: 200, headers: "Content-Type: application/json\r\n", body: "{}" }],
    ["HTTP/1.1 204 No Content\r\n\r\n", { status: 204, headers: "", body: "" }],
    ["HTTP/1.0 200 OK\nX-Test: true\n\nbody\n", { status: 200, headers: "X-Test: true\n", body: "body\n" }],
  ]) assert.deepEqual(await remoteHTTP({ execute: async () => ({ code: 0, stdout }) }, "server", link.url), expected);
  for (const response of [{ code: 22, stdout: "private-error" }, { code: 0, stdout: "banner\nHTTP/1.1 200 OK\r\n\r\n{}" }]) {
    await assert.rejects(remoteHTTP({ execute: async () => response }, "server", link.url), { code: "PROVIDER_LINK_HTTP" });
  }
});

test("provider management authenticates over SSH stdin and restricts methods, destinations and response status", async () => {
  const calls = [], replies = [
    "HTTP/1.1 303 See Other\r\nSet-Cookie: ignored=short\r\nSet-Cookie: magpie_web_fixture=" + key + "; Path=/; HttpOnly\r\n\r\n",
    'HTTP/1.1 200 OK\r\n\r\n{"providers":[]}',
    'HTTP/1.1 200 OK\r\n\r\n{"saved":true}',
    "HTTP/1.1 302 Found\r\nLocation: http://elsewhere.invalid/\r\n\r\n",
  ];
  const sessions = { async execute(id, command, options) {
    assert.equal(command, "sh -s"); assert.equal(id, "server"); calls.push(options);
    return { code: 0, stdout: replies.shift() };
  } };
  const api = await remoteProviderAPI(sessions, "server", link);
  assert.deepEqual(await api("/api/providers"), { providers: [] });
  assert.deepEqual(await api("/api/provider/save", { id: "provider", name: "本机 𠮷", key: "fixture-provider-secret" }), { saved: true });
  assert.ok(calls[0].input.includes(key)); assert.ok(calls[1].input.includes("Cookie: magpie_web_fixture=" + key));
  assert.ok(calls[2].input.includes("fixture-provider-secret"));
  await assert.rejects(api("/api/provider/save", { id: "provider" }), { code: "PROVIDER_LINK_API" });
  for (const path of ["/api/keys", "http://elsewhere.invalid/", "/api/providers?extra=true"]) await assert.rejects(api(path));
  assert.equal(calls.length, 4);
});

test("invalid links, malformed cookies and unsuccessful sign-in never gain an administration API", async () => {
  for (const url of ["http://192.168.1.1:3430/?k=" + key, "https://127.0.0.1:3430/?k=" + key, "http://127.0.0.1:3430/admin?k=" + key, "http://127.0.0.1:3430/?k=short"]) {
    await assert.rejects(remoteProviderAPI({ execute() { assert.fail("invalid link must not be requested"); } }, "server", { url }), { code: "PROVIDER_LINK_AUTH" });
  }
  for (const stdout of ["HTTP/1.1 200 OK\r\n\r\n{}", "HTTP/1.1 303 See Other\r\nSet-Cookie: magpie_web_fixture=bad; Path=/\r\n\r\n"]) {
    await assert.rejects(remoteProviderAPI({ execute: async () => ({ code: 0, stdout }) }, "server", link), { code: "PROVIDER_LINK_AUTH" });
  }
  for (const [url, options] of [["https://127.0.0.1/", {}], ["http://user:pass@127.0.0.1/", {}], ["http://127.0.0.1/", { method: "DELETE" }], ["http://127.0.0.1/", { headers: { Authorization: "bad\r\nInjected: true" } }]]) {
    assert.throws(() => remoteHTTPScript(url, options));
  }
});
