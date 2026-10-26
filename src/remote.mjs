import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { identifier } from "./config.mjs";
import { OperationError, errorDetails } from "./errors.mjs";
import { profileRevision } from "./store.mjs";
import { actionScript, probeScript, remoteActions, shellQuote, webLinkCommand } from "./remote-scripts.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const copy = (value) => value === undefined ? undefined : structuredClone(value);
const labels = { install: "安装 Magpie", update: "更新 Magpie", start: "启动服务", stop: "停止服务", restart: "重启服务", enable_web: "启用管理页面", uninstall: "卸载 Magpie" };
const uncertain = new Set(["REMOTE_TIMEOUT", "REMOTE_DISCONNECTED", "REMOTE_CANCELLED", "REMOTE_RESULT_UNKNOWN", "REMOTE_OUTPUT_LIMIT"]);
const steps = { preparing: "准备操作", verifying: "复核程序与服务文件", preparing_backup: "创建备份目录", backing_up: "备份配置", saving_binary: "保存旧程序", downloading: "下载程序", installing: "安装程序", updating: "执行官方更新", restarting: "重启用户服务", starting: "启动用户服务", stopping: "停止用户服务", enabling_web: "启用 Web 服务", uninstalling: "卸载程序与服务", checking_version: "检查更新后版本", healthcheck: "检查服务健康状态", completed: "执行完成" };
const reasons = {
  command_failed: "请在服务器核对该步骤的命令及运行环境。",
  permission: "远端报告权限不足或文件系统只读，请检查程序和配置目录的写入权限。",
  disk_full: "远端报告磁盘空间或配额不足，请释放空间后再操作。",
  network: "远端报告网络、代理或证书错误，请检查服务器到官方发布源和下载地址的连接。",
  interactive: "远端命令要求口令或交互终端，请核对该版本的非交互命令支持。",
  unsupported: "远端报告命令或参数不受支持，请核对当前版本的命令用法。",
  none: "",
};

function parseActionResult(stdout, operationId, exitCode) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith("MIGPIE_RESULT_V1\t"));
  if (lines.length !== 1) return;
  const [marker, id, step, code, reason, backupReady, extra] = lines[0].split("\t");
  if (marker !== "MIGPIE_RESULT_V1" || id !== operationId || !Object.hasOwn(steps, step) || !/^(?:0|[1-9]\d{0,2})$/.test(code) || Number(code) > 255 || (exitCode !== undefined && Number(code) !== exitCode) || !Object.hasOwn(reasons, reason) || !["true", "false"].includes(backupReady) || extra !== undefined) return;
  if (Number(code) === 0 ? step !== "completed" || reason !== "none" : step === "completed" || reason === "none") return;
  return { step, exitCode: Number(code), reason, backupReady: backupReady === "true" };
}

function actionFailure(action, exitCode, result) {
  if (exitCode === 75 && !result) return new OperationError("REMOTE_BUSY", "远端操作锁被占用，未重复执行");
  const step = result && steps[result.step];
  let message = (step ? step + "失败" : "远端操作未成功结束") + "（退出码 " + exitCode + "）。";
  message += result ? reasons[result.reason] : "此任务未返回具体失败阶段，请检测实际版本和服务状态。";
  if (action === "update" && ["preparing", "verifying", "preparing_backup", "backing_up", "saving_binary"].includes(result?.step)) message += "本次尚未执行更新。";
  if (action === "update" && ["restarting", "checking_version", "healthcheck"].includes(result?.step)) message += "更新命令已完成，请检查当前程序版本和服务状态，避免重复更新。";
  return new OperationError("REMOTE_ACTION_FAILED", message);
}

function backupDirectory(instance, operationId) {
  return instance.configDirectory.replace(/\/magpie$/, "/magpie-remote/backups/") + operationId;
}

export function parseProbe(stdout) {
  const lines = stdout.trim().split(/\r?\n/u);
  if (lines.shift() !== "MIGPIE_REMOTE_V1") throw new OperationError("REMOTE_PROTOCOL", "远端环境响应无效，请检查登录脚本输出");
  const fields = {};
  for (const line of lines) {
    const [key, value, extra] = line.split("\t");
    if (!/^[a-zA-Z]+$/.test(key) || extra !== undefined || value === undefined || value.length > 16384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw new OperationError("REMOTE_PROTOCOL", "远端环境字段无效");
    }
    fields[key] = Buffer.from(value, "base64").toString("utf8");
  }
  if (!fields.platform || !fields.architecture || !fields.home?.startsWith("/") || !fields.username) throw new OperationError("REMOTE_PROTOCOL", "远端环境信息不完整");
  for (const key of ["home", "binary", "managedBinary", "configDirectory", "unit"]) {
    if (fields[key] && /[\x00-\x1f\x7f]/.test(fields[key])) throw new OperationError("REMOTE_PROTOCOL", "远端路径包含控制字符");
  }
  return {
    platform: fields.platform, architecture: fields.architecture, username: fields.username,
    home: fields.home, container: fields.container === "true", binary: fields.binary ?? "", managedBinary: fields.managedBinary,
    version: fields.version ?? "", binaryHash: fields.binaryHash ?? "", configDirectory: fields.configDirectory, unit: fields.unit,
    unitHash: fields.unitHash ?? "", installed: fields.installed === "true", systemd: fields.systemd === "true",
    service: { installed: fields.serviceInstalled === "true", state: fields.systemd !== "true" ? "unavailable" : fields.serviceActive === "active" ? "running" : ["inactive", "failed", ""].includes(fields.serviceActive ?? "") ? "stopped" : "unknown" },
    web: { enabled: fields.webEnabled === "true", port: Number(fields.webPort) || 3430, tls: fields.webTLS === "true" },
    linger: fields.linger === "yes", locked: fields.locked === "true", tools: (fields.tools ?? "").trim().split(/\s+/).filter(Boolean),
    capabilities: (fields.capabilities ?? "").trim().split(/\s+/).filter(Boolean),
  };
}

export async function latestRelease(architecture) {
  const arch = { x86_64: "amd64", aarch64: "arm64", amd64: "amd64", arm64: "arm64" }[architecture];
  if (!arch) throw new OperationError("REMOTE_UNSUPPORTED", "首版安装支持 Linux amd64 和 arm64");
  let data;
  try {
    const response = await fetch("https://usemagpie.ai/api/latest", { signal: AbortSignal.timeout(15000), redirect: "error" });
    if (!response.ok) throw new Error("release feed unavailable");
    const text = await response.text();
    if (Buffer.byteLength(text) > 262144) throw new Error("release feed too large");
    data = JSON.parse(text);
  } catch (cause) { throw new OperationError("REMOTE_RELEASE_UNAVAILABLE", "无法读取官方版本清单，请稍后重试", { cause }); }
  const name = `magpie-cli-linux-${arch}`;
  const asset = data.assets?.[name];
  let url;
  try { url = new URL(asset?.url); } catch { /* Checked below. */ }
  if (!/^v?\d+\.\d+\.\d+$/.test(data.version ?? "") || !/^[a-f0-9]{64}$/i.test(asset?.sha256 ?? "") || url?.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith("/yetone/magpie-releases/releases/download/") || !url.pathname.endsWith("/" + name) || url.search || url.hash || url.username || url.password) {
    throw new OperationError("REMOTE_RELEASE_INVALID", "官方版本清单结构不受支持，未执行安装");
  }
  return { version: data.version, url: url.href, sha256: asset.sha256.toLowerCase() };
}

export class RemoteManager {
  #records = new Map();
  #previews = new Map();
  #tasks = new Set();
  #queue = Promise.resolve();
  #ready;
  #closed = false;

  constructor({ store, sessions, file = store.file + ".remote.json", release = latestRelease }) {
    this.store = store; this.sessions = sessions; this.file = file; this.release = release;
    this.#ready = this.#load();
    void this.#ready.catch(() => {});
  }

  async #load() {
    try {
      const contents = await readFile(this.file, "utf8");
      if (Buffer.byteLength(contents) > 8 * 1024 * 1024) throw new Error("remote state too large");
      const data = JSON.parse(contents);
      if (data.version !== 1 || !Array.isArray(data.records)) throw new Error("invalid remote state");
      for (const record of data.records) {
        identifier(record.connectionId);
        if (!/^[a-f0-9]{64}$/.test(record.binding ?? "") || this.#records.has(record.connectionId)) throw new Error("invalid remote binding");
        if (record.operation !== undefined) {
          const operation = record.operation;
          if (!operation || typeof operation !== "object" || Array.isArray(operation)
            || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operation.id ?? "")
            || !remoteActions.includes(operation.action) || !/^[a-f0-9]{64}$/.test(operation.revision ?? "")
            || !["running", "succeeded", "failed", "unknown"].includes(operation.state)
            || typeof operation.message !== "string") throw new Error("invalid remote operation");
        }
        if (record.operation?.state === "running") {
          record.operation.state = "unknown";
          record.operation.message = "插件已重启，请连接后检测远端操作结果";
        }
        this.#records.set(record.connectionId, record);
      }
    } catch (cause) {
      if (cause.code !== "ENOENT") throw new OperationError("REMOTE_STATE_INVALID", "远程管理记录无法读取，请检查文件后重试；未覆盖原文件", { cause });
    }
  }

  #save() {
    const contents = JSON.stringify({ version: 1, records: [...this.#records.values()] }, null, 2) + "\n";
    const pending = this.#queue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
        await rename(temporary, this.file);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    this.#queue = pending;
    return pending;
  }

  async #profile(id) {
    await this.#ready;
    if (this.#closed) throw new OperationError("REMOTE_CLOSED", "远程管理已关闭");
    identifier(id);
    return this.store.get(id);
  }

  #record(id, profile) {
    const binding = hash([profile.id, profile.host, profile.port, profile.username]);
    let record = this.#records.get(id);
    if (record && record.binding !== binding) {
      if (["running", "unknown"].includes(record.operation?.state)) throw new OperationError("REMOTE_BINDING_CHANGED", "此连接的服务器身份已变化，旧操作结果仍待核实，请使用独立连接管理新服务器");
      this.#records.delete(id); record = undefined;
    }
    if (!record) { record = { connectionId: id, binding }; this.#records.set(id, record); }
    return record;
  }

  #connected(id) {
    if (this.#closed || this.sessions.status(id).state !== "connected") throw new OperationError("REMOTE_NOT_CONNECTED", "请先建立 SSH 连接，再管理远程 Magpie");
  }

  async #probe(id, signal) {
    this.#connected(id);
    const response = await this.sessions.execute(id, "sh -s", { input: probeScript, signal, timeoutMs: 20000 });
    if (response.code !== 0) throw new OperationError("REMOTE_PROBE_FAILED", "环境检测失败，需要 POSIX shell、base64 与可读的用户目录");
    return parseProbe(response.stdout);
  }

  async status(id, { refresh = false, signal } = {}) {
    const profile = await this.#profile(id), record = this.#record(id, profile);
    if (refresh) {
      if (record.operation?.state === "running") throw new OperationError("REMOTE_BUSY", "远端操作正在执行，请等待结果后再检测");
      record.instance = await this.#probe(id, signal);
      record.observedAt = new Date().toISOString();
      if (record.operation?.state === "unknown") await this.#reconcile(id, record, signal);
      await this.#save();
    }
    const actions = record.instance && Object.fromEntries(remoteActions.map((action) => {
      try { this.#validate(action, record.instance); return [action, { enabled: true }]; }
      catch (error) { return [action, { enabled: false, reason: error.message, code: error.code }]; }
    }));
    return { ...copy(record), ...(actions && { actions }), stale: this.sessions.status(id).state !== "connected" };
  }

  async #reconcile(id, record, signal) {
    const operation = record.operation;
    if (!/^[a-f0-9-]{36}$/.test(operation.id)) return;
    const script = `set -eu\nbase="\${XDG_CONFIG_HOME:-$HOME/.config}/magpie-remote"\ncat "$base/operations/${operation.id}/state" 2>/dev/null || true\nprintf '\\n'\ncat "$base/operations/${operation.id}/result" 2>/dev/null || true\n`;
    const response = await this.sessions.execute(id, "sh -s", { input: script, signal, timeoutMs: 10000 });
    const lines = response.stdout.trim().split(/\r?\n/), state = lines[0];
    const result = parseActionResult(response.stdout, operation.id);
    const consistent = lines.length === 1 || (lines.length === 2 && result && (state === "succeeded" ? result.exitCode === 0 && result.step === "completed" : result.exitCode !== 0));
    if (response.code === 0 && ["succeeded", "failed"].includes(state) && consistent && !record.instance.locked) {
      operation.state = state; operation.step = state === "succeeded" ? "completed" : result?.step ?? "failed";
      operation.updatedAt = new Date().toISOString();
      delete operation.error;
      if (result) operation.diagnostic = { step: result.step, exitCode: result.exitCode, reason: result.reason };
      if (operation.action === "update" && (state === "succeeded" || result?.backupReady)) operation.result = { backupDirectory: backupDirectory(record.instance, operation.id) };
      if (state === "failed" && result) operation.error = errorDetails(actionFailure(operation.action, result.exitCode, result));
      operation.message = state === "succeeded" ? "已根据远端完成记录核实操作结束，请检查当前环境" : operation.error?.message ?? "远端记录显示操作失败，请检查实际状态后处理";
    } else operation.message = record.instance.locked ? "远端操作锁仍存在，请等待或在服务器核实任务；未重复执行" : "未取得明确完成记录，仍需在服务器核实结果；未重复执行";
  }

  #validate(action, instance) {
    if (!remoteActions.includes(action)) throw new OperationError("REMOTE_ACTION_INVALID", "未知的远程管理操作");
    if (instance.platform !== "Linux" || instance.container) throw new OperationError("REMOTE_UNSUPPORTED", "首版支持普通 Linux 用户安装；容器请通过镜像管理部署");
    if (instance.locked) throw new OperationError("REMOTE_BUSY", "远端存在未释放的管理操作锁，请先核实操作状态");
    if (action === "install") {
      if (instance.installed || instance.service.installed) throw new OperationError("REMOTE_ALREADY_INSTALLED", "检测到已有程序或服务，请使用现有安装");
      for (const tool of ["curl", "sha256sum", "mktemp", "install"]) if (!instance.tools.includes(tool)) throw new OperationError("REMOTE_PREREQUISITE", "安装需要远端命令：" + tool);
    } else if (!instance.installed) throw new OperationError("REMOTE_NOT_INSTALLED", "请先安装或修复远程 Magpie");
    if (["start", "stop", "restart", "enable_web"].includes(action) && !instance.systemd) throw new OperationError("REMOTE_NO_SYSTEMD", "当前 SSH 用户无法访问 systemd 用户服务，请使用服务器已有的进程管理器");
    if (["start", "stop", "restart"].includes(action) && !instance.service.installed) throw new OperationError("REMOTE_NO_SERVICE", "尚未安装用户服务，请先启用管理页面");
    if (action === "update" && instance.service.installed && !instance.systemd) throw new OperationError("REMOTE_NO_SYSTEMD", "无法访问已有用户服务，请先修复 systemd 用户会话");
    if (action === "enable_web" && instance.web.tls) throw new OperationError("REMOTE_TLS", "现有服务已配置 TLS，请在服务器保留其证书设置并启用 Web");
    if (instance.service.installed && instance.service.state === "unknown") throw new OperationError("REMOTE_SERVICE_UNKNOWN", "用户服务状态尚不明确，请先在服务器检查后再操作");
    if (!instance.tools.includes("sha256sum")) throw new OperationError("REMOTE_PREREQUISITE", "变更需要远端 sha256sum 复核程序和服务文件");
    if (action === "uninstall" && instance.service.installed && !instance.systemd) throw new OperationError("REMOTE_NO_SYSTEMD", "无法访问已有用户服务，未删除程序");
    if (action === "uninstall" && instance.binary !== instance.managedBinary) throw new OperationError("REMOTE_EXTERNAL_INSTALL", "自动卸载仅支持当前用户的 ~/.local/bin/magpie，请使用原安装方式处理其他路径");
    if (action === "install") return;
    if (!Array.isArray(instance.capabilities)) throw new OperationError("REMOTE_CAPABILITIES_UNKNOWN", "请重新检测环境，读取此安装的命令能力");
    const requireCommand = (capability, command) => {
      if (!instance.capabilities.includes(capability)) throw new OperationError("REMOTE_CAPABILITY_UNSUPPORTED", "当前程序的帮助信息未确认支持 " + command + "，请在服务器核对或更新程序");
    };
    if (action === "update") {
      requireCommand("update", "magpie update");
      if (!instance.capabilities.includes("backup") && !instance.tools.includes("tar")) throw new OperationError("REMOTE_PREREQUISITE", "当前程序未提供官方备份命令，更新前需要远端 tar 保存配置归档");
      if (instance.service.state === "running") { requireCommand("daemon_restart", "magpie daemon restart"); requireCommand("healthcheck", "magpie healthcheck"); }
    }
    if (["start", "stop", "restart"].includes(action)) requireCommand("daemon_" + action, "magpie daemon " + action);
    if (["start", "restart", "enable_web"].includes(action)) requireCommand("healthcheck", "magpie healthcheck");
    if (action === "enable_web") requireCommand("daemon_install_web", "magpie daemon install --web --addr");
    if (action === "uninstall" && instance.service.installed) requireCommand("daemon_uninstall", "magpie daemon uninstall");
    if (action === "uninstall" && !instance.tools.includes("readlink")) throw new OperationError("REMOTE_PREREQUISITE", "卸载需要远端 readlink 核实默认安装路径");
  }

  async preview(id, action, { signal } = {}) {
    const profile = await this.#profile(id), record = this.#record(id, profile);
    if (["running", "unknown"].includes(record.operation?.state)) throw new OperationError("REMOTE_BUSY", "已有远端操作尚未完成核实，请先检测其结果");
    const instance = await this.#probe(id, signal);
    this.#validate(action, instance);
    const release = action === "install" ? await this.release(instance.architecture) : undefined;
    const warnings = [], changes = [];
    if (action === "install") changes.push(`下载并校验官方 CLI ${release.version}`, "安装到 " + instance.managedBinary, "本次只安装程序，随后可启用用户服务与管理页面");
    const backupMode = action === "update" ? (instance.capabilities.includes("backup") ? "encrypted" : "archive") : undefined;
    if (action === "update") {
      changes.push(backupMode === "encrypted" ? "使用本次口令创建远端加密备份，并保留旧程序" : "先保存当前配置目录的 config.tar.gz 归档及旧程序；配置目录不存在时记录为空", "执行官方更新" + (instance.service.state === "running" ? "，重启现有服务并检查健康状态" : "，保持服务未运行状态"));
      if (backupMode === "encrypted") warnings.push("备份不包含订阅和插件登录，恢复后可能需要重新登录", "请保存本次备份口令，恢复加密配置时需要它");
      else warnings.push("当前程序未提供官方备份命令，配置归档未加密，可能含供应商密钥与登录信息；仅保存在远端当前用户可访问的目录，请妥善保管", "配置归档与官方加密备份格式不同，需要在服务器手动恢复，不提供自动回退");
      warnings.push("更新可能中断现有请求；备份位于远端 Magpie 配置旁的 magpie-remote/backups/，配置迁移后的回退需要单独验证");
    }
    if (action === "enable_web") {
      changes.push("安装或更新当前用户的 Magpie 服务并启动", "管理页面仅监听远端 127.0.0.1:3430，通过 SSH 本地转发访问");
      warnings.push("服务重新配置可能短暂中断请求；首次安装服务会继承本次 SSH 会话的运行环境");
    }
    if (["start", "stop", "restart"].includes(action)) changes.push(labels[action], action === "stop" ? "保留程序、配置和用户服务文件" : "检查网关健康状态");
    if (["stop", "restart"].includes(action)) warnings.push("当前正在使用远端网关的请求可能中断");
    if (action === "uninstall") {
      changes.push("停止并移除已检测到的用户服务", "移除 " + instance.managedBinary, "保留供应商配置、登录信息和备份");
      warnings.push("请先在官方页面恢复仍接入此网关的 Agent 配置；本次不会自动改写各 Agent", "仅处理当前用户的默认安装，不清理其他实例、容器或系统服务");
    }
    if (!instance.linger && ["start", "enable_web"].includes(action)) warnings.push("未确认启用 linger，退出 SSH 后用户服务可能停止；需要时在服务器配置 loginctl enable-linger");
    const revision = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    this.#previews.set(id, { action, revision, baseline: hash(instance), profile: profileRevision(profile), instance, release, backupMode, expires: Date.now() + 300000 });
    record.instance = instance; record.observedAt = new Date().toISOString(); await this.#save();
    return { connectionId: id, action, revision, summary: labels[action], changes, warnings, requiresBackupPassphrase: backupMode === "encrypted", ...(backupMode && { backupMode }) };
  }

  async apply(id, action, revision, { backupPassphrase } = {}) {
    const profile = await this.#profile(id), record = this.#record(id, profile), preview = this.#previews.get(id);
    if (record.operation?.state === "running") {
      if (record.operation.action === action && record.operation.revision === revision) return copy(record.operation);
      throw new OperationError("REMOTE_BUSY", "同一服务器已有管理操作正在执行");
    }
    if (record.operation?.revision === revision) return copy(record.operation);
    if (record.operation?.state === "unknown") throw new OperationError("REMOTE_BUSY", "上次操作结果待核实，请先连接并检测");
    if (!preview || preview.action !== action || preview.revision !== revision || preview.expires < Date.now() || preview.profile !== profileRevision(profile)) throw new OperationError("REMOTE_PREVIEW_STALE", "操作预览已过期或连接配置已变化，请重新预览");
    if (preview.backupMode === "encrypted" && (typeof backupPassphrase !== "string" || backupPassphrase.length < 12 || backupPassphrase.length > 1024 || /[\x00-\x1f\x7f]/.test(backupPassphrase))) throw new OperationError("REMOTE_PASSPHRASE_REQUIRED", "请填写至少 12 个字符的本次备份口令，不能包含换行");
    this.#connected(id);
    const operation = { id: randomUUID(), action, revision, state: "running", step: "checking", message: "正在复核环境", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const previous = record.operation;
    record.operation = operation;
    try { await this.#save(); }
    catch (cause) { record.operation = previous; throw new OperationError("REMOTE_STATE_WRITE_FAILED", "无法保存操作记录，未执行远端变更", { cause }); }
    const task = this.#run(id, record, preview, backupPassphrase);
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task)).catch(() => {});
    return copy(operation);
  }

  async #run(id, record, preview, passphrase) {
    const operation = record.operation;
    try {
      const instance = await this.#probe(id);
      if (this.#closed) throw new OperationError("REMOTE_CLOSED", "远程管理已关闭，未执行变更");
      if (hash(instance) !== preview.baseline) throw new OperationError("REMOTE_PREVIEW_STALE", "远端程序、服务或环境已变化，请重新预览");
      this.#validate(operation.action, instance);
      operation.step = "executing"; operation.message = labels[operation.action] + "中，刷新页面后可继续查看";
      await this.#save();
      const script = actionScript(operation.action, instance, operation.id, preview.release);
      const command = preview.backupMode === "encrypted" ? "sh -c '" + script.replaceAll("'", "'\\''") + "'" : "sh -s";
      const input = preview.backupMode === "encrypted" ? passphrase + "\n" : script;
      passphrase = undefined;
      const response = await this.sessions.execute(id, command, { input, timeoutMs: 600000, maxBytes: 65536 });
      const result = parseActionResult(response.stdout, operation.id, response.code);
      if (result) {
        operation.diagnostic = { step: result.step, exitCode: result.exitCode, reason: result.reason };
        if (operation.action === "update" && result.backupReady) operation.result = { backupDirectory: backupDirectory(instance, operation.id) };
      }
      if (response.code !== 0) throw actionFailure(operation.action, response.code, result);
      if (!response.stdout.split(/\r?\n/).includes("MIGPIE_DONE") || (!result && response.stdout.includes("MIGPIE_RESULT_V1"))) throw new OperationError("REMOTE_RESULT_UNKNOWN", "远端完成标记缺失或结果记录无效，请检测实际状态");
      operation.state = "succeeded"; operation.step = "completed"; operation.message = labels[operation.action] + "已完成";
      if (operation.action === "update") operation.result = { backupDirectory: backupDirectory(instance, operation.id) };
      try { record.instance = await this.#probe(id); record.observedAt = new Date().toISOString(); }
      catch { operation.message += "，当前环境尚未刷新，请重新检测"; }
    } catch (error) {
      operation.state = operation.step === "executing" && uncertain.has(error.code) ? "unknown" : "failed";
      operation.step = operation.state === "failed" ? operation.diagnostic?.step ?? "failed" : operation.state;
      operation.error = errorDetails(error); operation.message = error.message;
    } finally {
      passphrase = undefined; operation.updatedAt = new Date().toISOString();
      try { await this.#save(); }
      catch { operation.state = "unknown"; operation.message = "远端操作已返回，但本地记录保存失败，请重新检测结果"; }
    }
  }

  async operation(id, operationId) {
    const profile = await this.#profile(id), operation = this.#record(id, profile).operation;
    if (operationId && operationId !== operation?.id) throw new OperationError("REMOTE_OPERATION_MISSING", "未找到此连接的操作记录");
    return copy(operation ?? null);
  }

  async web(id, { port } = {}) {
    const profile = await this.#profile(id), record = this.#record(id, profile);
    this.#connected(id);
    const instance = await this.#probe(id);
    if (!instance.installed || !instance.web.enabled || instance.web.tls) throw new OperationError("REMOTE_WEB_UNAVAILABLE", "请先启用回环 HTTP 管理页面；已有 TLS 服务请使用其原访问方式");
    if (!instance.capabilities.includes("daemon_web")) throw new OperationError("REMOTE_CAPABILITY_UNSUPPORTED", "当前程序的帮助信息未确认支持 magpie daemon web，请更新程序后获取管理链接");
    const response = await this.sessions.execute(id, webLinkCommand(instance), { timeoutMs: 15000, maxBytes: 16384 });
    const text = response.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    const match = text.match(/http:\/\/(?:127\.0\.0\.1|localhost):([0-9]+)\/\?k=([A-Za-z0-9._~-]{16,256})/);
    if (response.code !== 0 || !match) throw new OperationError("REMOTE_WEB_UNAVAILABLE", "无法读取用户服务的回环管理链接，请在服务器检查 magpie daemon web");
    const targetPort = Number(match[1]);
    if (port !== undefined && port !== targetPort) throw new OperationError("REMOTE_WEB_PORT", "端口与服务实际管理端口不一致，请重新检测");
    const forwardId = "magpie-web";
    let forward = this.sessions.status(id).forwards.find((item) => item.id === forwardId);
    if (forward && (forward.direction !== "c2s" || forward.targetHost !== "127.0.0.1" || forward.targetPort !== targetPort || forward.bindHost !== "127.0.0.1")) throw new OperationError("REMOTE_WEB_FORWARD", "magpie-web 转发标识已被其他规则占用，请先处理该规则");
    if (!forward) forward = await this.sessions.addForward(id, { id: forwardId, name: "远程 Magpie 管理", direction: "c2s", bindHost: "127.0.0.1", bindPort: 0, targetHost: "127.0.0.1", targetPort });
    record.instance = instance; record.observedAt = new Date().toISOString();
    const address = `http://127.0.0.1:${forward.bindPort}/`;
    return { address, url: address + "?k=" + match[2] };
  }

  async assertIdle(id) {
    await this.#ready;
    if (["running", "unknown"].includes(this.#records.get(id)?.operation?.state)) throw new OperationError("REMOTE_BUSY", "远端管理操作尚未完成核实，请保留此连接并先检测结果");
  }

  async assertProfileChange(profile) {
    await this.#ready;
    const record = this.#records.get(profile.id);
    if (record?.operation?.state === "running") await this.assertIdle(profile.id);
    if (record?.operation?.state === "unknown" && record.binding !== hash([profile.id, profile.host, profile.port, profile.username])) await this.assertIdle(profile.id);
  }

  async assertAllIdle() {
    await this.#ready;
    for (const id of this.#records.keys()) await this.assertIdle(id);
  }

  async forget(id) {
    await this.assertIdle(id);
    this.#records.delete(id); this.#previews.delete(id); await this.#save();
  }

  async close() { this.#closed = true; await Promise.allSettled([...this.#tasks]); await this.#queue.catch(() => {}); }
}
