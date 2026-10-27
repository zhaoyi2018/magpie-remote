import test from "node:test";
import assert from "node:assert/strict";
import { connectionGuidance, launcherURL, managementFailure, readResponse } from "../page/recovery.js";

test("expired desktop and loopback pages return to their plugin launcher, not the stale service", () => {
  for (const origin of ["http://wails.localhost", "http://127.0.0.1:3425", "http://localhost:3425", "http://[::1]:3425"]) {
    const launcher = origin + "/_magpie/plugin/migpie-remote/index.html?revision=2";
    assert.equal(launcherURL("#" + new URLSearchParams({ launcher })), launcher);
  }
  for (const launcher of ["https://example.com/_magpie/plugin/x", "http://wails.localhost.evil.test/_magpie/plugin/x", "http://wails.localhost:9000/_magpie/plugin/x", "http://127.0.0.1:3425/settings", "http://user:password@localhost/_magpie/plugin/x", "javascript:alert(1)"]) {
    assert.equal(launcherURL("#" + new URLSearchParams({ launcher })), null);
  }
  assert.equal(launcherURL(""), null);
});

test("configuration failures remain actionable without being described as a stopped server", async () => {
  for (const code of ["CONFIG_INVALID", "CONFIG_UNREADABLE"]) {
    const response = new Response(JSON.stringify({ code, error: "配置文件不可用" }), { status: 400 });
    await assert.rejects(readResponse(response), (error) => {
      const failure = managementFailure(error);
      assert.match(failure.label, /配置/);
      assert.match(failure.message, /仍在运行/);
      assert.equal(failure.action, "retry");
      return true;
    });
  }
  assert.equal(managementFailure({ code: "SERVICE_UNREACHABLE" }).action, "reopen");
  assert.equal(managementFailure({ code: "MANAGEMENT_EXPIRED" }).action, "reopen");
  assert.equal(managementFailure({ code: "REQUEST_TIMEOUT", message: "请求超时" }).action, "retry");
});

test("connection guidance explains verified host trust, agent and credential recovery", () => {
  assert.match(connectionGuidance({ code: "HOST_KEY_UNTRUSTED", category: "trust" }), /独立核对.*不要直接信任/);
  assert.match(connectionGuidance({ code: "HOST_KEY_UNAVAILABLE" }), /known_hosts.*权限/);
  assert.match(connectionGuidance({ code: "SSH_AUTH_FAILED" }, { authMethod: "agent" }), /ssh-add -l.*Windows.*SSH_AUTH_SOCK/);
  assert.match(connectionGuidance({ code: "KEY_UNAVAILABLE" }), /私钥路径/);
  assert.match(connectionGuidance({ code: "CREDENTIALS_REQUIRED" }), /填写凭据并连接/);
  assert.match(connectionGuidance({ code: "SSH_TIMEOUT" }), /防火墙/);
  assert.equal(connectionGuidance({ code: "FORWARD_REJECTED", message: "fixture secret" }), "");
});

test("the page retains credential requirements and handles invalid responses explicitly", async () => {
  await assert.rejects(readResponse(new Response(JSON.stringify({ error: "请输入私钥口令", code: "CREDENTIALS_REQUIRED", credentialFields: ["passphrase"] }), { status: 400 })), {
    code: "CREDENTIALS_REQUIRED", credentialFields: ["passphrase"],
  });
  await assert.rejects(readResponse(new Response("not JSON", { status: 502 })), { code: "INVALID_RESPONSE" });
  await assert.rejects(readResponse(new Response("null", { status: 502 })), { code: "INVALID_RESPONSE" });
  await assert.rejects(readResponse(new Response(JSON.stringify({ error: "expired" }), { status: 401 })), { code: "MANAGEMENT_EXPIRED" });
});
