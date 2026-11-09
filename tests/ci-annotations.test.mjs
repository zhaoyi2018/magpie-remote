import test from "node:test";
import assert from "node:assert/strict";
import { failureAnnotation } from "../scripts/ci-annotations.mjs";

test("CI annotations preserve the first TAP failure instead of only the final exit code", () => {
  const log = "ok 1 - earlier check\n# Subtest: Linux behavior\nnot ok 2 - Linux behavior\n  error: expected running but got stopped\n" + "later output\n".repeat(100);
  const annotation = failureAnnotation({ id: "node-tests", code: 1 }, log);
  assert.match(annotation, /^::error title=Verification%3A node-tests::/);
  assert.ok(annotation.includes("not ok 2 - Linux behavior"));
  assert.ok(annotation.includes("expected running but got stopped"));
});

test("CI annotations escape workflow commands, remove ANSI codes and cap diagnostics", () => {
  const annotation = failureAnnotation({ id: "fixture,check", reason: "50% failed\r\n::notice::untrusted", code: 1 }, "\x1b[31mAssertionError: mismatch\x1b[0m\n" + "x".repeat(20000));
  assert.ok(annotation.startsWith("::error title=Verification%3A fixture%2Ccheck::"));
  assert.ok(annotation.includes("50%25 failed%0D%0A::notice::untrusted"));
  assert.ok(!annotation.includes("\n"));
  assert.ok(!annotation.includes("\x1b"));
  assert.ok(annotation.length < 8500);
});

test("CI annotations use Node spec failure details instead of the earlier progress line", () => {
  const log = "✖ a channel-open timeout (500ms)\n" + "✔ later passing test\n".repeat(100) + "✖ failing tests:\n\ntest at tests/forward-diagnostics.test.mjs:7:1\n✖ a channel-open timeout\n  Error: TCP data truncated\n";
  const annotation = failureAnnotation({ id: "node-tests", code: 1 }, log);
  assert.ok(annotation.includes("Error: TCP data truncated"));
  assert.ok(annotation.includes("tests/forward-diagnostics.test.mjs:7:1"));
});
