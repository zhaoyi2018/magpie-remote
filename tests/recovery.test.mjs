import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { connectionGuidance, launcherURL, managementFailure, managementURL, readResponse, recoveryOrigin, recoveryProof, signedRecovery } from "../page/recovery.js";

test("expired desktop and loopback pages return to their plugin launcher, not the stale service", () => {
  for (const origin of ["http://wails.localhost", "http://127.0.0.1:3425", "http://localhost:3425", "http://[::1]:3425"]) {
    const launcher = origin + "/_magpie/plugin/migpie-remote/index.html?revision=2";
    assert.equal(launcherURL("#" + new URLSearchParams({ launcher })), launcher);
  }
  for (const launcher of ["https://example.com/_magpie/plugin/x", "http://wails.localhost.evil.test/_magpie/plugin/x", "http://wails.localhost:9000/_magpie/plugin/x", "http://127.0.0.1:3425/settings", "http://user:password@localhost/_magpie/plugin/x", "javascript:alert(1)"]) {
    assert.equal(launcherURL("#" + new URLSearchParams({ launcher })), null);
  }
  assert.equal(launcherURL(""), null);
  for (const launcher of ["http://localhost/_magpie/plugin/x/../../settings", "http://localhost/_magpie/plugin/x;/index.html", "http://localhost/_magpie/plugin/x/other.js"]) {
    assert.equal(launcherURL("?" + new URLSearchParams({ launcher })), null);
  }
});

test("a discovered management endpoint is limited to an authenticated loopback address", () => {
  const token = "a".repeat(43);
  assert.equal(managementURL(`http://127.0.0.1:1234/${token}/`).pathname, `/${token}/`);
  for (const value of [`http://localhost:1234/${token}/`, `http://127.0.0.1:1234/${token}/?x=1`, `http://user@127.0.0.1/${token}/`, `http://127.0.0.1/${token}/other`]) {
    assert.equal(managementURL(value), null);
  }
});

test("recovery signatures and proofs bind the challenge, purpose and exact candidate origin", async () => {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const recovery = { secret: randomBytes(32).toString("base64url"), publicKey: key.publicKey.export({ type: "spki", format: "der" }).toString("base64url") };
  const origin = "http://127.0.0.1:1234", challenge = randomBytes(32).toString("base64url");
  const signed = (payload) => {
    const message = JSON.stringify(payload);
    return { message, signature: sign("sha256", Buffer.from(message), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
  };
  const identity = signed({ version: 1, purpose: "identity", origin, challenge });
  assert.equal(await signedRecovery(recovery, origin, challenge, identity, "identity"), true);
  assert.equal(await signedRecovery(recovery, "http://127.0.0.1:1235", challenge, identity, "identity"), null);
  assert.equal(await signedRecovery(recovery, origin, randomBytes(32).toString("base64url"), identity, "identity"), null);
  assert.equal(await signedRecovery(recovery, origin, challenge, { ...identity, message: identity.message.replace("1234", "1235") }, "identity"), null);
  const wrongKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  assert.equal(await signedRecovery({ ...recovery, publicKey: wrongKey }, origin, challenge, identity, "identity"), null);
  assert.equal(await signedRecovery(recovery, origin, challenge, identity, "endpoint"), null);
  const target = `${origin}/${randomBytes(32).toString("base64url")}/`;
  const endpoint = signed({ version: 1, purpose: "endpoint", origin, challenge, url: target });
  assert.equal((await signedRecovery(recovery, origin, challenge, endpoint, "endpoint")).href, target);
  assert.equal(await signedRecovery(recovery, origin, challenge, signed({ version: 1, purpose: "endpoint", origin, challenge, url: target.replace("1234", "1235") }), "endpoint"), null);
  const expected = createHmac("sha256", Buffer.from(recovery.secret, "base64url")).update(origin + "\n" + challenge).digest("base64url");
  assert.equal(await recoveryProof(recovery.secret, origin, challenge), expected);
  assert.notEqual(await recoveryProof(recovery.secret, "http://127.0.0.1:1235", challenge), expected);
  assert.equal(recoveryOrigin(origin), origin);
  for (const value of ["http://localhost:1234", "http://127.0.0.1:1234/path", "https://127.0.0.1:1234", "http://user@127.0.0.1:1234"]) assert.equal(recoveryOrigin(value), null);
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
  const abort = new DOMException("response aborted", "AbortError");
  await assert.rejects(readResponse({ json: async () => { throw abort; } }), (error) => error === abort);
  const disconnected = new TypeError("response disconnected");
  await assert.rejects(readResponse({ json: async () => { throw disconnected; } }), (error) => error === disconnected);
  await assert.rejects(readResponse(new Response(JSON.stringify({ error: "expired" }), { status: 401 })), { code: "MANAGEMENT_EXPIRED" });
});
