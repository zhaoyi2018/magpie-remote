import { remoteActions } from "./remote-scripts.mjs";
import { libraryAction, libraryOptions } from "./remote-library.mjs";

export const operationHistoryLimit = 20;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const states = ["running", "succeeded", "failed", "unknown"];
const restoreStates = {
  configState: ["not_applied", "applied", "rolled_back", "unknown"],
  serviceState: ["unchanged", "running", "stopped", "unknown"],
  rollbackState: ["not_needed", "succeeded", "failed"],
};
const libraryConfigStates = ["not_applied", "applied", "rolled_back", "unknown"];
const libraryCompletedStates = ["synced", "unchanged", "unsupported", "no_agents", "gateway_mode"];
const librarySyncStates = ["not_started", ...libraryCompletedStates, "failed", "unknown"];

export function parseLibraryResult(stdout, operationId, succeeded) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith("MIGPIE_LIBRARY_RESULT_V1\t"));
  if (lines.length !== 1) return;
  const [, id, configState, syncState, extra] = lines[0].split("\t");
  if (id !== operationId || extra !== undefined || !libraryConfigStates.includes(configState) || !librarySyncStates.includes(syncState)
    || (configState !== "applied" && syncState !== "not_started")
    || (succeeded && (configState !== "applied" || !libraryCompletedStates.includes(syncState)))) return;
  return { configState, syncState };
}

export function libraryResultMessage(library) {
  if (!library) return "";
  if (library.configState === "unknown") return "资源库落盘状态待核实";
  if (library.configState === "rolled_back") return "已恢复写入前的资源库";
  if (library.configState !== "applied") return "";
  return "资源库已落盘；" + {
    not_started: "尚未执行 Agent 同步",
    synced: "已执行 magpie library sync",
    unchanged: "Magpie 报告无需更新 Agent 配置，可能没有可应用的 Agent",
    unsupported: "此 Magpie 版本未确认支持 library sync，资源暂未应用到 Agent",
    no_agents: "Magpie 未检测到可应用的 Agent",
    gateway_mode: "远端处于 Gateway 模式，资源暂未应用到 Agent",
    failed: "Agent 同步失败，可能已有部分 Agent 配置发生变化",
    unknown: "Agent 同步结果待核实",
  }[library.syncState];
}

export function terminalOperation(operation) {
  return ["succeeded", "failed"].includes(operation?.state);
}

export function parseRestoreResult(stdout, operationId) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith("MIGPIE_RESTORE_V1\t"));
  if (lines.length !== 1) return;
  const [marker, id, configState, serviceState, rollbackState, encoded, extra] = lines[0].split("\t");
  if (marker !== "MIGPIE_RESTORE_V1" || id !== operationId || extra !== undefined || encoded === undefined
    || !restoreStates.configState.includes(configState) || !restoreStates.serviceState.includes(serviceState)
    || !restoreStates.rollbackState.includes(rollbackState) || encoded.length > 16384
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return;
  const recoveryDirectory = Buffer.from(encoded, "base64").toString("utf8");
  if (Buffer.from(recoveryDirectory).toString("base64") !== encoded
    || (recoveryDirectory && (!recoveryDirectory.startsWith("/") || /[\x00-\x1f\x7f]/.test(recoveryDirectory)))
    || ((rollbackState === "succeeded") !== (configState === "rolled_back"))
    || ((rollbackState === "failed") !== (configState === "unknown"))
    || (serviceState === "running" && configState !== "applied")) return;
  return { configState, serviceState, rollbackState, ...(recoveryDirectory && { recoveryDirectory }) };
}

export function restoreResultMessage(restore) {
  if (!restore) return "";
  const config = { not_applied: "配置尚未应用", applied: "配置已应用", rolled_back: "原配置已还原", unknown: "配置状态待核实" }[restore.configState];
  const service = { unchanged: "服务保持操作前状态", running: "服务已启动并通过健康检查", stopped: "服务已停止", unknown: "服务状态待核实" }[restore.serviceState];
  const rollback = restore.rollbackState === "failed" ? "；原配置还原失败，请先核实保留目录" : "";
  return `${config}；${service}${rollback}${restore.recoveryDirectory ? "；恢复依据：" + restore.recoveryDirectory : ""}`;
}

export function operationSummary(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation) || !uuid.test(operation.id ?? "")
    || !remoteActions.includes(operation.action) || !states.includes(operation.state)
    || !/^[a-f0-9]{64}$/.test(operation.revision ?? "") || typeof operation.message !== "string"
    || operation.message.length > 16384) throw new Error("invalid remote operation");
  const summary = { id: operation.id, action: operation.action, revision: operation.revision, state: operation.state, message: operation.message };
  for (const field of ["step", "createdAt", "updatedAt"]) {
    if (operation[field] !== undefined) {
      if (typeof operation[field] !== "string" || operation[field].length > 128) throw new Error("invalid remote operation field");
      summary[field] = operation[field];
    }
  }
  if (operation.dispatch !== undefined) {
    if (!["pending", "possible"].includes(operation.dispatch)) throw new Error("invalid dispatch state");
    summary.dispatch = operation.dispatch;
  }
  if (operation.backupId !== undefined) {
    if (!uuid.test(operation.backupId)) throw new Error("invalid operation backup");
    summary.backupId = operation.backupId;
  }
  if (operation.error) {
    summary.error = {};
    for (const field of ["code", "message", "category"]) {
      if (typeof operation.error[field] !== "string" || operation.error[field].length > 16384) throw new Error("invalid operation error");
      summary.error[field] = operation.error[field];
    }
    summary.error.retryable = operation.error.retryable === true;
  }
  if (operation.diagnostic) {
    const { step, exitCode, reason } = operation.diagnostic;
    if (typeof step !== "string" || step.length > 64 || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255
      || typeof reason !== "string" || reason.length > 64) throw new Error("invalid operation diagnostic");
    summary.diagnostic = { step, exitCode, reason };
  }
  if (operation.result?.backupDirectory) {
    const directory = operation.result.backupDirectory;
    if (typeof directory !== "string" || directory.length > 16384 || /[\x00-\x1f\x7f]/.test(directory)) throw new Error("invalid backup directory");
    summary.result = { backupDirectory: directory };
  }
  if (operation.restore) {
    const { configState, serviceState, rollbackState, recoveryDirectory } = operation.restore;
    const encoded = recoveryDirectory === undefined ? "" : Buffer.from(recoveryDirectory).toString("base64");
    const restore = parseRestoreResult(`MIGPIE_RESTORE_V1\t${operation.id}\t${configState}\t${serviceState}\t${rollbackState}\t${encoded}`, operation.id);
    if (!restore || operation.action !== "restore") throw new Error("invalid restore result");
    summary.restore = restore;
  }
  if (operation.library) {
    const { configState, syncState } = operation.library;
    if (operation.action !== libraryAction || !libraryConfigStates.includes(configState) || !librarySyncStates.includes(syncState)) throw new Error("invalid library result");
    summary.library = { ...libraryOptions(operation.library), configState, syncState };
  }
  return summary;
}
