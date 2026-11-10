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

test("HTTP failures retain their status and target while stripping login credentials and response output", async () => {
  for (const status of [401, 403, 404, 500]) {
    for (const code of [0, 22]) {
      const sessions = { execute: async () => ({ code, stdout: `HTTP/1.1 ${status} Failed\r\nSet-Cookie: private=${key}\r\n\r\nprivate-body-${key}`, stderr: "private-stderr-" + key }) };
      await assert.rejects(remoteHTTP(sessions, "server", link.url, { context: "登录远端 Web 管理服务" }), (error) => {
        assert.equal(error.code, "PROVIDER_LINK_HTTP");
        assert.ok(error.message.includes(`HTTP ${status}`));
        assert.ok(error.message.includes("登录远端 Web 管理服务（http://127.0.0.1:3430/）"));
        for (const value of [key, "?k=", "private-body", "private-stderr", "Set-Cookie"]) assert.ok(!error.message.includes(value));
        return true;
      });
    }
  }
});

test("curl failures distinguish connection errors, timeouts, missing tools and unsupported options", async () => {
  for (const [code, reason] of [[2, "不支持请求参数"], [7, "无法连接目标端口"], [28, "请求超时"], [52, "未返回 HTTP 响应"], [69, "缺少 curl"], [22, "未取得有效状态码"]]) {
    await assert.rejects(remoteHTTP({ execute: async () => ({ code, stdout: "private-stdout-" + key, stderr: "private-stderr-" + key }) }, "server", link.url), (error) => {
      assert.ok(error.message.includes(reason)); assert.ok(error.message.includes(`curl 退出码 ${code}`));
      assert.ok(error.message.includes("http://127.0.0.1:3430/"));
      assert.ok(!error.message.includes(key) && !error.message.includes("private-"));
      return error.code === "PROVIDER_LINK_HTTP";
    });
  }
});

test("management errors identify sign-in, provider reading and provider saving independently", async () => {
  const signedIn = { code: 0, stdout: "HTTP/1.1 303 See Other\r\nSet-Cookie: magpie_web_fixture=" + key + "; Path=/\r\n\r\n" };
  for (const [phase, description, path] of [[0, "登录远端 Web 管理服务", "/"], [1, "读取远端供应商列表", "/api/providers"], [2, "保存远端供应商", "/api/provider/save"]]) {
    let requests = 0;
    const sessions = { execute: async () => requests++ === phase ? { code: 22, stdout: `HTTP/1.1 401 Unauthorized\r\n\r\nprivate-body-${key}` }
      : requests === 1 ? signedIn : { code: 0, stdout: 'HTTP/1.1 200 OK\r\n\r\n{"providers":[]}' } };
    const call = async () => {
      const api = await remoteProviderAPI(sessions, "server", link);
      await api("/api/providers");
      await api("/api/provider/save", { id: "fixture", key });
    };
    await assert.rejects(call(), (error) => {
      assert.ok(error.message.includes(description));
      assert.ok(error.message.includes("http://127.0.0.1:3430" + path));
      assert.ok(error.message.includes("HTTP 401"));
      assert.ok(!error.message.includes(key) && !error.message.includes("?k="));
      return error.code === "PROVIDER_LINK_HTTP";
    });
    assert.equal(requests, phase + 1);
  }
});
