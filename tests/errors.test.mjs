import test from "node:test";
import assert from "node:assert/strict";
import { OperationError, errorDetails, sshFailure } from "../src/errors.mjs";

test("only temporary transport failures are eligible for automatic retries", () => {
  for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EAI_AGAIN"]) {
    const error = sshFailure(Object.assign(new Error(code), { code }));
    assert.equal(error.category, "network");
    assert.equal(error.retryable, true);
  }
  for (const error of [
    Object.assign(new Error("authentication failed"), { level: "client-authentication" }),
    Object.assign(new Error("agent unavailable"), { level: "agent" }),
    Object.assign(new Error("bad hostname"), { code: "ENOTFOUND" }),
    Object.assign(new Error("unsupported algorithm"), { level: "handshake" }),
    new Error("unknown error"),
  ]) assert.equal(sshFailure(error).retryable, false);
  for (const code of ["HOST_KEY_REJECTED", "HOST_KEY_UNAVAILABLE", "CREDENTIALS_REQUIRED", "KEY_INVALID", "KEY_UNAVAILABLE", "FORWARD_REJECTED", "FORWARD_BIND_FAILED", "FORWARD_TIMEOUT", "CONFIG_INVALID", "CONFIG_UNREADABLE", "OPERATION_CANCELLED"]) {
    assert.equal(errorDetails(new OperationError(code, "test")).retryable, false);
  }
  assert.equal(errorDetails(new OperationError("SSH_DISCONNECTED", "closed")).retryable, true);
});
