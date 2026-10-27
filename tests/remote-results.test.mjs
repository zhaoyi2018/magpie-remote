import test from "node:test";
import assert from "node:assert/strict";
import { operationSummary, parseRestoreResult, restoreResultMessage } from "../src/remote-results.mjs";

const id = "79e2990d-4a82-45e5-951d-1d1a581ff756";
const record = (config = "applied", service = "running", rollback = "not_needed", directory = "") => `MIGPIE_RESTORE_V1\t${id}\t${config}\t${service}\t${rollback}\t${Buffer.from(directory).toString("base64")}\n`;

test("restore records preserve empty trailing fields and decode recovery paths", () => {
  assert.deepEqual(parseRestoreResult(record(), id), { configState: "applied", serviceState: "running", rollbackState: "not_needed" });
  const directory = "/home/测试 user/.magpie-restore.123/previous";
  const restore = parseRestoreResult(record("unknown", "stopped", "failed", directory), id);
  assert.equal(restore.recoveryDirectory, directory);
  assert.match(restoreResultMessage(restore), /配置状态待核实.*服务已停止.*还原失败.*previous/);
});

test("restore records reject duplicate, unrelated, malformed and contradictory evidence", () => {
  for (const stdout of [record() + record(), record().replace(id, "unrelated"), record().replace("applied", "untrusted"), record().trim(), record() + "MIGPIE_RESTORE_V1\tbroken\n", record("applied", "stopped", "failed"), record("unknown", "stopped", "succeeded"), record("applied", "running", "not_needed", "relative/path"), record("applied", "running", "not_needed", "/path\nsecret"), record().replace(/\t\n$/, "\t%%%\n")]) {
    assert.equal(parseRestoreResult(stdout, id), undefined, stdout);
  }
});

test("operation summaries retain structured recovery evidence and discard raw or secret fields", () => {
  const summary = operationSummary({ id, action: "restore", revision: "a".repeat(64), state: "failed", message: "fixture failure", dispatch: "possible", step: "starting", stdout: "raw secret", credentials: { password: "secret" }, progress: { downloadedBytes: 10 }, result: { backupDirectory: "/home/tester/backups/" + id, raw: "secret" }, restore: parseRestoreResult(record("applied", "unknown", "not_needed", "/home/tester/backups/" + id), id) });
  assert.equal(summary.restore.configState, "applied");
  assert.equal(summary.stdout, undefined); assert.equal(summary.credentials, undefined); assert.equal(summary.progress, undefined); assert.equal(summary.result.raw, undefined);
  assert.ok(!JSON.stringify(summary).includes("secret"));
});
