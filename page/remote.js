const actionLabels = {
  install: "安装 Magpie", update: "更新 Magpie", start: "启动服务", stop: "停止服务",
  restart: "重启服务", enable_web: "启用 Web", uninstall: "卸载 Magpie",
  backup: "创建备份", restore: "恢复配置", delete_backup: "删除备份",
};
const panelActions = ["install", "update", "start", "stop", "restart", "enable_web", "uninstall", "backup"];
const serviceActions = new Set(["start", "stop", "restart", "enable_web"]);
const backupActions = new Set(["backup", "update", "restore", "delete_backup"]);
const operationLabels = { running: "执行中", succeeded: "已完成", failed: "失败", unknown: "结果未知" };
const stepLabels = { checking: "复核环境", executing: "执行变更", preparing: "准备操作", verifying: "复核程序与服务文件", preparing_backup: "创建备份目录", backing_up: "备份配置", saving_binary: "保存旧程序", downloading: "下载程序", installing: "安装程序", updating: "执行官方更新", restoring: "恢复配置", deleting_backup: "删除备份", restarting: "重启用户服务", starting: "启动用户服务", stopping: "停止用户服务", enabling_web: "启用 Web 服务", uninstalling: "卸载程序与服务", checking_version: "检查更新后版本", healthcheck: "检查服务健康状态", completed: "执行完成", failed: "执行失败", unknown: "等待核实" };
const serviceLabels = { running: "运行中", stopped: "已停止", unavailable: "不可用", unknown: "待核实" };
const backupFormatLabels = { encrypted: "历史加密备份", archive: "配置归档", absent: "无配置目录快照", incomplete: "备份不完整" };

export function createRemoteManager({ call, toast }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $("remote-preview");
  let row = null, online = false, active = false, remoteActive = false, closed = false;
  let generation = 0, dataRevision = 0, previewSequence = 0, webSequence = 0, backupSequence = 0;
  let status = null, operation = null, reading = null, polling = null;
  let preview = null, previewAction = null, previewBackupId = null, previewLoading = false, submitting = false, webLoading = false;
  let readError = "", actionError = "", webError = "", submissionUncertain = false, uncertainSubmission = null;
  let backups = null, backupsLoading = null, backupError = "", backupsDirty = false, backupRefreshDue = false, completedBackupOperation = null;
  const pendingSubmissions = new Set(), backupRows = new Map();

  function setText(node, value) {
    const next = String(value ?? "");
    if (node.textContent !== next) node.textContent = next;
  }
  function text(id, value) { setText($(id), value); }
  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }
  function current(id, epoch) { return !closed && row?.connection.id === id && generation === epoch; }
  function sshReady() { return online && row?.session.state === "connected"; }
  function running() { return operation?.state === "running"; }
  function uncertain() { return submissionUncertain || operation?.state === "unknown"; }
  function fresh() { return Boolean(sshReady() && status?.instance && !status.stale && !readError); }
  function time(value) {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "时间未知";
  }
  function size(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "大小未知";
    if (bytes < 1024) return bytes + " B";
    const unit = bytes < 1024 ** 2 ? 1 : bytes < 1024 ** 3 ? 2 : 3;
    return (bytes / 1024 ** unit).toLocaleString("zh-CN", { maximumFractionDigits: 1 }) + " " + ["B", "KB", "MB", "GB"][unit];
  }
  function errorMessage(error) { return error?.message || "请求失败，请检测环境后重试。"; }
  function showError(id, message) { text(id, message); $(id).hidden = !message; }

  function clearWeb() {
    webSequence++; webLoading = false; webError = "";
    $("remote-web-url").value = "";
    $("remote-web-result").hidden = true;
    text("remote-web-address", "");
    showError("remote-web-error", "");
  }
  function closePreview() {
    previewSequence++; preview = null; previewAction = null; previewBackupId = null; previewLoading = false;
    if (dialog.open) dialog.close();
  }

  function taskReason() {
    if (!row) return "请先选择 SSH 服务器。";
    if (!online) return "管理服务不可用，当前仅显示缓存。";
    if (!sshReady()) return "请先建立 SSH 连接，服务状态与 SSH 连接状态分别显示。";
    if (submitting || pendingSubmissions.has(row.connection.id)) return "正在提交远端任务，请稍候。";
    if (running()) return "远端任务仍在执行，可在运行日志查看进度。";
    if (uncertain()) return "上次操作结果未知。请先检测环境核实；结果明确前不要重复操作。";
    if (previewLoading) return "正在读取变更预览。";
    return "";
  }
  function baseReason(action) {
    const reason = taskReason();
    if (reason) return reason;
    if (!fresh()) return "请点击「检测环境」核实远端安装与服务状态。";
    if (String(status.instance.platform).toLowerCase() !== "linux") return "当前仅支持管理 Linux 上的 Magpie。";
    if (status.instance.container) return "容器环境请通过镜像管理部署，此处暂不支持变更。";
    if (status.instance.locked) return "远端仍有管理操作锁，请先在服务器核实任务状态。";
    if (action !== "delete_backup" && status.instance.service?.installed && status.instance.service.state === "unknown") return "用户服务状态待核实，请先检测环境或在服务器检查。";
    return "";
  }
  function actionReason(action, backupId) {
    const reason = baseReason(action);
    if (reason) return reason;
    const instance = status.instance;
    if (["restore", "delete_backup"].includes(action)) {
      const backup = backups?.backups.find((entry) => entry.id === backupId);
      if (!backup || backupsDirty) return "请先刷新备份列表，确认要操作的备份。";
      if (action === "restore" && !["archive", "absent"].includes(backup.format)) return backup.format === "encrypted" ? "历史加密备份需使用原工具手动恢复，此处可删除备份。" : "此条目没有完整的配置快照，无法自动恢复。";
    }
    if (action === "update" && status.update?.state !== "available") return status.update?.state === "current" ? "已是最新版。" : "请先检测新版本，确认有更新后再执行。";
    const availability = status.actions?.[action];
    if (!availability) return "请重新检测环境，读取可用操作。";
    if (!availability.enabled) return availability.reason || "当前环境不支持此操作，请重新检测。";
    if (action === "delete_backup") return "";
    if (action === "install") return instance.installed || instance.service?.installed ? "已检测到 Magpie 程序或用户服务，请使用已有安装。" : "";
    if (!instance.installed) return "请先安装 Magpie。";
    if (["update", "uninstall"].includes(action) && instance.service?.installed && !instance.systemd) return "无法访问已有用户服务，请先修复 systemd 用户会话。";
    if (action === "enable_web" && instance.web?.tls) return "已有服务配置了 TLS，请在服务器保留证书设置并启用 Web。";
    if (action === "uninstall" && instance.managedBinary && instance.binary !== instance.managedBinary) return "自动卸载仅支持当前用户的 ~/.local/bin/magpie，请使用原安装方式处理。";
    if (serviceActions.has(action) && !instance.systemd) return "未检测到 systemd，无法管理用户服务；仍可安装、更新或卸载程序。";
    if (["start", "stop", "restart"].includes(action) && !instance.service?.installed) return "尚未安装用户服务，请先启用 Web。";
    if (action === "start" && instance.service?.state === "running") return "服务已在运行。";
    if (action === "stop" && instance.service?.state === "stopped") return "服务已停止。";
    if (action === "enable_web" && instance.web?.enabled && instance.service?.installed) return "官方 Web 与用户服务已启用。";
    return "";
  }
  function backupListReason() {
    return taskReason() || (status?.instance?.locked ? "远端仍有管理操作锁，请先检测环境核实。" : "");
  }
  function webReason() {
    const reason = baseReason();
    if (reason) return reason;
    if (!status.instance.installed) return "请先安装 Magpie。";
    if (status.instance.web?.tls) return "已有 Web 配置了 TLS，请使用服务器原有访问方式。";
    if (!status.instance.web?.enabled) return "请先启用 Web。";
    if (!status.instance.capabilities?.includes("daemon_web")) return "当前程序未提供管理链接命令，请先更新 Magpie。";
    if (status.instance.service?.state !== "running") return "请先启动远端服务。";
    return "";
  }

  function drawUpdate(detecting) {
    const update = status?.update, instance = status?.instance;
    const state = update?.state;
    const currentVersion = update?.currentVersion || instance?.version;
    let label = "尚未确认最新版本", detail = "检测环境时会一并检查可用更新。";
    if (state === "current") {
      label = "已是最新版";
      detail = currentVersion ? "当前版本 " + currentVersion + "。" : "当前程序与最新发布版本一致。";
    } else if (state === "available") {
      label = update.latestVersion ? "发现新版本 " + update.latestVersion : "发现可用更新";
      detail = currentVersion ? "当前版本 " + currentVersion + "。更新前会创建配置备份。" : "更新前会创建配置备份。";
    } else if (update?.error) {
      label = "新版本检测失败";
      detail = errorMessage(update.error) + " 可重新检测新版本。";
    } else if (instance && !instance.installed) {
      detail = "安装 Magpie 后可检查当前版本是否有更新。";
    } else if (currentVersion) {
      detail = "当前版本 " + currentVersion + "，尚未确认最新发布版本。";
    }
    if (instance?.installed && status.actions?.update?.enabled === false && status.actions.update.reason) detail += " " + status.actions.update.reason;
    if (update?.checkedAt) detail += " 检测于 " + time(update.checkedAt) + "。";
    if (status && !fresh()) detail += " 当前显示缓存，请重新检测。";
    text("remote-update-state", label); text("remote-update-detail", detail);
    $("remote-update-state").className = state === "available" ? "is-available" : update?.error ? "is-warning" : "";
    $("remote-action-update").hidden = state !== "available";
    $("remote-action-install").hidden = Boolean(instance?.installed || instance?.service?.installed);
    $("remote-check-update").disabled = $("remote-detect").disabled;
    $("remote-check-update").title = $("remote-detect").title;
    text("remote-check-update", detecting ? "正在检测…" : state === "available" || state === "current" ? "重新检测" : "检测新版本");
  }

  function draw() {
    if (closed) return;
    const instance = status?.instance;
    const stale = Boolean(status && (!sshReady() || status.stale || readError));
    text("remote-ssh-state", !online ? "SSH 通道：状态待同步" : sshReady() ? "SSH 通道：已连接" : "SSH 通道：未连接");
    $("remote-ssh-state").className = "badge" + (sshReady() ? " connected" : "");
    text("remote-install-state", instance ? (instance.installed ? "已安装 Magpie" : "尚未安装 Magpie") : "尚未检测远端环境");
    text("remote-observed", status?.observedAt ? (stale ? "缓存 · " : "检测于 ") + time(status.observedAt) : "检测后显示程序与服务信息");
    $("remote-observed").classList.toggle("is-stale", stale);
    let notice = !row ? "选择一台服务器后，检测远端 Magpie 环境。"
      : !online ? "管理服务不可用，当前显示最后读取的状态。恢复连接后请重新检测。"
      : !sshReady() ? "SSH 尚未连接，保留的远端状态仅供参考。请先连接服务器。"
      : stale ? "当前显示缓存，请检测环境后再进行变更。"
      : !instance ? "先检测环境，确认安装位置、版本与用户服务状态。" : "SSH 通道与 Magpie 用户服务各自独立；服务启停不会断开 SSH 连接。";
    if (uncertain()) notice = "上次操作结果未知。请点击「检测环境」核实远端结果；结果明确前不会允许重复操作。";
    text("remote-notice", notice);
    $("remote-notice").classList.toggle("is-warning", stale || uncertain());
    $("remote-environment").hidden = !instance;
    text("remote-platform", instance ? [instance.platform, instance.architecture, instance.container ? "容器环境" : ""].filter(Boolean).join(" / ") : "—");
    text("remote-user", instance ? [instance.username, instance.home].filter(Boolean).join(" / ") : "—");
    text("remote-binary", instance?.binary || "未找到程序");
    text("remote-version", instance?.version ? "版本 " + instance.version : instance?.installed ? "版本待核实" : "");
    text("remote-config", instance?.configDirectory || "尚未检测到配置目录");
    const service = instance?.service;
    text("remote-service", !instance?.systemd ? "无 systemd" : !service?.installed ? "尚未安装用户服务" : serviceLabels[service.state] ?? "待核实");
    $("remote-service").className = "badge" + (service?.state === "running" ? " connected" : service?.state === "unknown" ? " connecting" : "");
    text("remote-web-state", instance?.web?.enabled ? "已启用 · 远端端口 " + instance.web.port : "尚未启用");
    const detecting = Boolean(reading?.forced || reading?.queued);
    $("remote-detect").disabled = !sshReady() || detecting || running() || submitting || pendingSubmissions.has(row?.connection.id);
    $("remote-detect").title = running() ? "远端任务执行中，请在运行日志查看进度；结束后可检测环境。" : "通过 SSH 读取远端环境并检查最新版本";
    text("remote-detect-label", detecting ? "正在检测…" : "检测环境");
    showError("remote-error", actionError || readError);
    for (const action of panelActions) {
      const button = $("remote-action-" + action), reason = actionReason(action);
      button.disabled = Boolean(reason); button.title = reason || "预览变更后确认执行";
    }
    text("remote-action-hint", baseReason() || (instance?.installed ? "每次变更前先预览，更新会保留当前配置与备份。" : "安装到当前 SSH 用户的默认位置；安装后可启用 Web 与用户服务。"));
    text("remote-service-hint", instance && !instance.systemd ? "未检测到 systemd，无法管理用户服务；其他操作是否可用见对应按钮提示。" : instance?.installed && !instance.service?.installed ? (status.actions?.enable_web?.enabled ? "尚未安装用户服务。请先点击「启用 Web」创建并启动服务，再使用启停按钮。" : "尚未安装用户服务。" + (status.actions?.enable_web?.reason || "请先检测环境。")) : "启用 Web 会配置用户服务；服务启停不会断开 SSH 连接。");
    drawUpdate(detecting);
    const reason = webReason();
    $("remote-open-web").disabled = Boolean(reason) || webLoading;
    $("remote-open-web").title = reason || "通过仅监听本机的 SSH 通道生成访问地址";
    text("remote-open-web", webLoading ? "正在建立通道…" : "获取 Web 地址");
    text("remote-web-hint", reason || "远端 Web 默认使用 3430 端口，仅通过本机回环 SSH 通道访问。");
    showError("remote-web-error", webError);
    drawBackups(); drawTaskSummary(); syncPreview();
  }

  function drawBackups() {
    const reason = backupListReason();
    $("remote-refresh-backups").disabled = Boolean(reason || backupsLoading);
    $("remote-refresh-backups").title = reason || "读取这台服务器的配置备份，不会自动轮询列表";
    $("remote-backup-list").setAttribute("aria-busy", String(Boolean(backupsLoading)));
    text("remote-refresh-backups-label", backupsLoading ? "正在读取…" : "刷新列表");
    let message = reason || "点击「刷新列表」读取这台服务器的备份。";
    if (backupsLoading) message = "正在读取备份列表，已有条目会保留。";
    else if (backups) {
      const stale = !sshReady() || backupsDirty || backupError;
      message = backups.backups.length ? backups.backups.length + " 份备份，" : "尚无备份，";
      message += (stale ? "上次读取于 " : "读取于 ") + time(backups.observedAt) + "。";
      if (reason) message += " " + reason;
      else if (backupsDirty) message += " 内容可能已变化，请刷新列表。";
      else if (!backups.backups.length) message += " 安装程序后可创建配置备份。";
    }
    text("remote-backups-state", message);
    showError("remote-backups-error", backupError);
    for (const [id, item] of backupRows) {
      for (const [action, button] of [["restore", item.restore], ["delete_backup", item.remove]]) {
        const blocked = actionReason(action, id);
        button.disabled = Boolean(blocked || backupsLoading);
        button.title = blocked || (backupsLoading ? "正在刷新备份列表，请稍候。" : "预览变更后确认执行");
      }
    }
  }

  function renderBackupRows() {
    const list = $("remote-backup-list"), entries = backups?.backups ?? [];
    const focused = document.activeElement, hadFocus = list.contains(focused), ids = new Set(entries.map((entry) => entry.id));
    for (const [id, item] of backupRows) {
      if (!ids.has(id)) { item.node.remove(); backupRows.delete(id); }
    }
    entries.forEach((entry, index) => {
      let item = backupRows.get(entry.id);
      if (!item) {
        const node = element("article", "remote-backup-item");
        const body = element("div", "remote-backup-body"), heading = element("div", "remote-backup-heading");
        const createdAt = element("strong"), format = element("span", "remote-backup-format");
        heading.append(createdAt, format);
        const directory = element("p", "remote-path"), metadata = element("p", "remote-backup-meta");
        const version = element("span"), bytes = element("span"), binary = element("span"), note = element("p", "remote-backup-note");
        metadata.append(version, bytes, binary); body.append(heading, directory, metadata, note);
        const actions = element("div", "remote-actions remote-backup-actions");
        const restore = element("button", "button small", "恢复配置"), remove = element("button", "text-button danger", "删除备份");
        for (const [action, button] of [["restore", restore], ["delete_backup", remove]]) {
          button.type = "button"; button.dataset.action = action; button.dataset.backupId = entry.id;
        }
        actions.append(restore, remove); node.append(body, actions);
        item = { node, createdAt, format, directory, version, bytes, binary, note, restore, remove };
        backupRows.set(entry.id, item);
      }
      setText(item.createdAt, time(entry.createdAt));
      setText(item.format, backupFormatLabels[entry.format] || "格式未知");
      item.format.className = "remote-backup-format" + (entry.format === "archive" ? " is-archive" : " is-warning");
      setText(item.directory, entry.directory);
      setText(item.version, entry.version || "版本未知");
      setText(item.bytes, size(entry.size));
      setText(item.binary, entry.hasBinary ? "含程序副本，恢复时保留当前程序" : ""); item.binary.hidden = !entry.hasBinary;
      setText(item.note, entry.format === "encrypted" ? "历史加密备份需使用原工具手动恢复，此处可删除备份。" : entry.format === "archive" ? "先完整保存当前配置与程序，停止运行中的服务后还原配置目录；保留当前程序并重启原先运行的服务。" : entry.format === "absent" ? "记录了当时没有配置目录的状态。恢复前保存当前配置与程序，再移除当前配置目录；保留当前程序。" : "此条目没有完整的配置快照，无法自动恢复，可删除以清理目录。");
      item.restore.setAttribute("aria-label", "恢复 " + time(entry.createdAt) + " 的配置备份");
      item.remove.setAttribute("aria-label", "删除 " + time(entry.createdAt) + " 的备份");
      if (list.children[index] !== item.node) list.insertBefore(item.node, list.children[index] || null);
    });
    if (hadFocus && !focused.isConnected) $("remote-refresh-backups").focus();
  }

  async function refreshBackups() {
    if (closed || backupListReason() || backupsLoading) return;
    const id = row.connection.id, epoch = generation, sequence = ++backupSequence;
    const owner = {}; backupsLoading = owner; backupError = ""; draw();
    try {
      const result = await call("remote_backups", { connectionId: id });
      if (!current(id, epoch) || sequence !== backupSequence) return;
      if (result?.connectionId !== id || !Array.isArray(result.backups)) throw new Error("备份列表与当前连接不匹配，请重新刷新。");
      backups = result; backupsDirty = false; renderBackupRows();
    } catch (error) {
      if (current(id, epoch) && sequence === backupSequence) backupError = errorMessage(error);
    } finally {
      if (current(id, epoch) && sequence === backupSequence && backupsLoading === owner) { backupsLoading = null; draw(); }
    }
  }

  function observeOperation(next) {
    const previous = operation;
    operation = next;
    if (["stop", "uninstall"].includes(next.action) && next.state === "succeeded" && (previous?.id !== next.id || previous?.state !== next.state)) clearWeb();
    if (backupActions.has(next.action) && ["succeeded", "failed"].includes(next.state)) {
      const key = [next.id, next.action, next.revision, next.state].join(":");
      if (key !== completedBackupOperation) {
        completedBackupOperation = key; backupsDirty = true; backupRefreshDue = true;
      }
    }
  }
  function maybeRefreshBackups() {
    if (!backupRefreshDue || backupListReason() || backupsLoading) return;
    backupRefreshDue = false; void refreshBackups();
  }

  function drawTaskSummary() {
    const state = operation?.state;
    text("remote-task-state", submitting ? "远端任务正在提交…" : submissionUncertain ? "远端任务提交结果待核实，请检测环境。" : operation ? (actionLabels[operation.action] ?? "远端任务") + "：" + (operationLabels[state] ?? "结果待核实") + (running() && operation.step ? "，" + (stepLabels[operation.step] ?? "处理远端任务") : "") : "远程操作的进度与结果会记录在运行日志中。");
    $("remote-task-summary").classList.toggle("is-warning", uncertain() || state === "failed");
  }

  function syncPreview() {
    if (!dialog.open) return;
    dialog.setAttribute("aria-busy", String(previewLoading || submitting));
    $("remote-apply").disabled = !preview || previewLoading || submitting || Boolean(actionReason(previewAction, previewBackupId));
    text("remote-apply", submitting ? "正在提交…" : previewAction ? "确认" + actionLabels[previewAction] : "确认执行");
    $("remote-apply").className = "button " + (["uninstall", "delete_backup"].includes(previewAction) ? "danger" : "primary");
  }

  function syncPolling() {
    const enabled = !closed && active && row && online && !document.hidden;
    if (!enabled && polling) { clearInterval(polling); polling = null; }
    if (enabled && !polling) polling = setInterval(() => { void refresh(); }, 2000);
  }

  function render(nextRow, options) {
    if (closed) return;
    const changed = row?.connection.id !== nextRow?.connection.id;
    const wasReady = sshReady(), wasActive = active, wasOnline = online, wasRemoteActive = remoteActive;
    if (changed) {
      generation++; dataRevision++; backupSequence++; reading = null; backupsLoading = null;
      status = null; operation = null; readError = actionError = ""; submissionUncertain = false; uncertainSubmission = null; submitting = false;
      backups = null; backupError = ""; backupsDirty = false; backupRefreshDue = false; completedBackupOperation = null;
      backupRows.clear(); $("remote-backup-list").replaceChildren();
      closePreview(); clearWeb(); $("remote-web-port").value = "3430";
    }
    row = nextRow ?? null; online = Boolean(options.online); remoteActive = Boolean(options.active);
    active = remoteActive || $("tab-logs").getAttribute("aria-selected") === "true";
    if ((wasReady && !sshReady()) || (!remoteActive && wasRemoteActive)) closePreview();
    if (!sshReady() || (!remoteActive && wasRemoteActive)) clearWeb();
    draw(); syncPolling();
    if (active && (changed || !wasActive || (!wasOnline && online) || (!wasReady && sshReady()))) void refresh();
    maybeRefreshBackups();
  }

  function refresh({ force = false } = {}) {
    if (closed || !active || !row || !online || document.hidden || submitting) return Promise.resolve();
    if (force && (!sshReady() || running())) return Promise.resolve();
    if (reading) {
      if (force && !reading.forced) reading.queued = true;
      draw(); return reading.promise;
    }
    const id = row.connection.id, epoch = generation;
    const owner = { forced: force, queued: false, promise: null };
    reading = owner;
    owner.promise = (async () => {
      try {
        do {
          const version = dataRevision;
          owner.queued = false;
          const probing = owner.forced;
          draw();
          try {
            const result = await call("remote_status", { connectionId: id, ...(probing && { refresh: true }) });
            if (!current(id, epoch) || version !== dataRevision) return;
            if (result?.connectionId !== id) throw new Error("远端状态与当前连接不匹配，请重新检测。");
            const wasRunning = running();
            status = result; readError = "";
            if (result.operation) {
              observeOperation(result.operation);
              if (!submissionUncertain || (operation.action === uncertainSubmission?.action && operation.revision === uncertainSubmission?.revision)) {
                submissionUncertain = false; uncertainSubmission = null;
              }
            }
            if (fresh() && (!result.instance.installed || result.instance.web?.enabled === false || result.instance.service?.state === "stopped")) clearWeb();
            if (probing && !running() && !uncertain()) actionError = "";
            if (wasRunning && operation && ["succeeded", "failed"].includes(operation.state) && !probing && sshReady()) owner.queued = true;
          } catch (error) {
            if (!current(id, epoch) || version !== dataRevision) return;
            readError = errorMessage(error);
          }
          if (!current(id, epoch)) return;
          owner.forced = owner.queued;
        } while (owner.queued && active && sshReady() && !document.hidden && !submitting && !running());
      } finally {
        if (current(id, epoch) && reading === owner) { reading = null; draw(); maybeRefreshBackups(); }
      }
    })();
    return owner.promise;
  }

  function list(id, values) {
    const nodes = (Array.isArray(values) ? values : []).map((value) => {
      const item = document.createElement("li"); item.textContent = value; return item;
    });
    $(id).replaceChildren(...nodes);
    $(id).closest("section").hidden = !nodes.length;
  }

  async function openPreview(action, backupId) {
    if (actionReason(action, backupId) || dialog.open) return;
    const id = row.connection.id, epoch = generation, sequence = ++previewSequence;
    preview = null; previewAction = action; previewBackupId = backupId ?? null; previewLoading = true;
    actionError = "";
    text("remote-preview-title", "预览" + actionLabels[action]);
    text("remote-preview-connection", row.connection.name + " · " + row.connection.username + "@" + row.connection.host);
    text("remote-preview-summary", "正在读取远端变更预览…");
    list("remote-preview-changes", []); list("remote-preview-warnings", []);
    showError("remote-preview-error", "");
    $("remote-preview-background").hidden = true;
    dialog.showModal(); draw();
    try {
      const result = await call("remote_preview", { connectionId: id, action, ...(backupId && { backupId }) });
      if (!current(id, epoch) || sequence !== previewSequence || !dialog.open) return;
      if (result?.connectionId !== id || result.action !== action || (backupId && result.backupId !== backupId)) throw new Error("操作预览与当前连接或备份不匹配，请关闭后重试。");
      preview = result;
      text("remote-preview-summary", result.summary);
      list("remote-preview-changes", result.changes); list("remote-preview-warnings", result.warnings);
    } catch (error) {
      if (current(id, epoch) && sequence === previewSequence && dialog.open) showError("remote-preview-error", errorMessage(error));
    } finally {
      if (current(id, epoch) && sequence === previewSequence) { previewLoading = false; draw(); }
    }
  }

  async function applyPreview(event) {
    event.preventDefault();
    if (!preview || submitting || actionReason(previewAction, previewBackupId)) return;
    const id = row.connection.id, epoch = generation, action = previewAction, revision = preview.revision;
    submitting = true; pendingSubmissions.add(id); dataRevision++;
    if (backupActions.has(action)) { backupSequence++; backupsLoading = null; backupsDirty = true; }
    showError("remote-preview-error", "");
    $("remote-preview-background").hidden = false;
    clearWeb(); draw();
    try {
      const result = await call("remote_apply", { connectionId: id, action, revision });
      if (!current(id, epoch)) return;
      if (!result || (result.connectionId && result.connectionId !== id)) throw new Error("未能核实远端任务，请检测环境确认结果。");
      observeOperation(result); submissionUncertain = false; uncertainSubmission = null;
      closePreview(); toast("远端任务已提交，可在运行日志查看进度与结果。");
    } catch (error) {
      if (!current(id, epoch)) return;
      const message = errorMessage(error);
      // A lost response may have reached the server. Keep mutations locked until
      // an actual operation is recovered instead of inviting a duplicate apply.
      submissionUncertain = ["REQUEST_TIMEOUT", "SERVICE_UNREACHABLE"].includes(error?.code) || !error?.code;
      uncertainSubmission = submissionUncertain ? { action, revision } : null;
      actionError = submissionUncertain ? "提交结果待核实：" + message : message;
      if (dialog.open) showError("remote-preview-error", actionError);
    } finally {
      pendingSubmissions.delete(id);
      if (current(id, epoch)) {
        submitting = false; draw();
        void refresh({ force: Boolean(operation && ["succeeded", "failed"].includes(operation.state)) });
        maybeRefreshBackups();
      }
    }
  }

  async function openWeb() {
    if (webReason() || webLoading) return;
    const input = $("remote-web-port");
    if (!input.reportValidity()) return;
    const id = row.connection.id, epoch = generation;
    clearWeb(); const sequence = webSequence;
    webLoading = true; draw();
    try {
      const result = await call("remote_web", { connectionId: id, port: Number(input.value) });
      if (!current(id, epoch) || sequence !== webSequence || !sshReady() || webReason()) return;
      if (!result?.url || !result.address) throw new Error("未获取到 Web 地址，请检查服务状态后重试。");
      $("remote-web-url").value = result.url;
      text("remote-web-address", "本机通道：" + result.address);
      $("remote-web-result").hidden = false;
      $("remote-web-url").focus(); $("remote-web-url").select();
    } catch (error) {
      if (current(id, epoch) && sequence === webSequence) webError = errorMessage(error);
    } finally {
      if (current(id, epoch) && sequence === webSequence) { webLoading = false; draw(); }
    }
  }

  for (const action of panelActions) $("remote-action-" + action).addEventListener("click", () => { void openPreview(action); });
  $("remote-detect").addEventListener("click", () => { void refresh({ force: true }); });
  $("remote-check-update").addEventListener("click", () => { void refresh({ force: true }); });
  $("remote-refresh-backups").addEventListener("click", () => { void refreshBackups(); });
  $("remote-backup-list").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (button && !button.disabled) void openPreview(button.dataset.action, button.dataset.backupId);
  });
  $("remote-view-logs").addEventListener("click", () => { $("tab-logs").click(); $("tab-logs").focus(); });
  $("remote-open-web").addEventListener("click", () => { void openWeb(); });
  $("remote-web-port").addEventListener("input", () => { clearWeb(); draw(); });
  $("remote-web-url").addEventListener("click", (event) => event.currentTarget.select());
  $("remote-hide-web").addEventListener("click", () => { clearWeb(); draw(); });
  dialog.querySelectorAll(".remote-close-preview").forEach((button) => button.addEventListener("click", () => { closePreview(); draw(); }));
  dialog.addEventListener("close", () => { if (!dialog.open) { closePreview(); draw(); } });
  $("remote-preview-form").addEventListener("submit", (event) => { void applyPreview(event); });
  $("remote-apply").addEventListener("click", (event) => { void applyPreview(event); });
  function visibilityChanged() { syncPolling(); if (!document.hidden) void refresh(); }
  document.addEventListener("visibilitychange", visibilityChanged);

  function close() {
    if (closed) return;
    closePreview(); clearWeb();
    closed = true; generation++; backupSequence++; reading = null; backupsLoading = null;
    if (polling) { clearInterval(polling); polling = null; }
    document.removeEventListener("visibilitychange", visibilityChanged);
  }
  return { render, refresh, close };
}
