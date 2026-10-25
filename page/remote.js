const actionLabels = {
  install: "安装 Magpie", update: "更新 Magpie", start: "启动服务", stop: "停止服务",
  restart: "重启服务", enable_web: "启用 Web", uninstall: "卸载 Magpie",
};
const serviceActions = new Set(["start", "stop", "restart", "enable_web"]);
const operationLabels = { running: "执行中", succeeded: "已完成", failed: "失败", unknown: "结果未知" };
const stepLabels = { checking: "复核环境", executing: "执行变更", completed: "执行完成", failed: "执行失败", unknown: "等待核实" };
const serviceLabels = { running: "运行中", stopped: "已停止", unavailable: "不可用", unknown: "待核实" };

export function createRemoteManager({ call, toast }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $("remote-preview");
  const passphrase = $("remote-backup-passphrase");
  let row = null, online = false, active = false, closed = false;
  let generation = 0, dataRevision = 0, previewSequence = 0, webSequence = 0;
  let status = null, operation = null, reading = null, polling = null;
  let preview = null, previewAction = null, previewLoading = false, submitting = false, webLoading = false;
  let readError = "", actionError = "", webError = "", submissionUncertain = false, uncertainSubmission = null;
  const pendingSubmissions = new Set();

  function text(id, value) {
    const node = $(id), next = String(value ?? "");
    if (node.textContent !== next) node.textContent = next;
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
  function errorMessage(error) { return error?.message || "请求失败，请检测环境后重试。"; }
  function showError(id, message) { text(id, message); $(id).hidden = !message; }

  function clearPassphrase() {
    passphrase.value = ""; passphrase.type = "password";
    $("remote-show-passphrase").setAttribute("aria-pressed", "false");
    text("remote-show-passphrase", "显示口令");
  }
  function clearWeb() {
    webSequence++; webLoading = false; webError = "";
    $("remote-web-url").value = "";
    $("remote-web-result").hidden = true;
    text("remote-web-address", "");
    showError("remote-web-error", "");
  }
  function closePreview() {
    previewSequence++; preview = null; previewAction = null; previewLoading = false;
    clearPassphrase();
    if (dialog.open) dialog.close();
  }

  function baseReason() {
    if (!row) return "请先选择 SSH 服务器。";
    if (!online) return "管理服务不可用，当前仅显示缓存。";
    if (!sshReady()) return "请先建立 SSH 连接，服务状态与 SSH 连接状态分别显示。";
    if (submitting || pendingSubmissions.has(row.connection.id)) return "正在提交远端任务，请稍候。";
    if (running()) return "远端任务仍在执行，可在下方查看进度。";
    if (uncertain()) return "上次操作结果未知。请先检测环境核实；结果明确前不要重复操作。";
    if (previewLoading) return "正在读取变更预览。";
    if (!fresh()) return "请点击「检测环境」核实远端安装与服务状态。";
    if (String(status.instance.platform).toLowerCase() !== "linux") return "当前仅支持管理 Linux 上的 Magpie。";
    if (status.instance.container) return "容器环境请通过镜像管理部署，此处暂不支持变更。";
    if (status.instance.locked) return "远端仍有管理操作锁，请先在服务器核实任务状态。";
    if (status.instance.service?.installed && status.instance.service.state === "unknown") return "用户服务状态待核实，请先检测环境或在服务器检查。";
    const version = status.instance.version?.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    if (status.instance.installed && (!version || !(Number(version[1]) > 0 || Number(version[2]) > 1 || Number(version[2]) === 1 && Number(version[3]) >= 1472))) return "此安装版本尚未支持，请先在服务器升级到 0.1.1472 或更新版本。";
    return "";
  }
  function actionReason(action) {
    const reason = baseReason();
    if (reason) return reason;
    const instance = status.instance;
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
  function webReason() {
    const reason = baseReason();
    if (reason) return reason;
    if (!status.instance.installed) return "请先安装 Magpie。";
    if (status.instance.web?.tls) return "已有 Web 配置了 TLS，请使用服务器原有访问方式。";
    if (!status.instance.web?.enabled) return "请先启用 Web。";
    if (status.instance.service?.state !== "running") return "请先启动远端服务。";
    return "";
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
      : !instance ? "先检测环境，确认安装位置、版本与用户服务状态。" : "SSH 通道只表示连接可用；下方用户服务状态表示 Magpie 是否运行。";
    if (uncertain()) notice = "上次操作结果未知。请点击「检测环境」核实远端结果；结果明确前不会允许重复操作。";
    text("remote-notice", notice);
    $("remote-notice").classList.toggle("is-warning", stale || uncertain());
    $("remote-environment").hidden = !instance;
    text("remote-platform", instance ? [instance.platform, instance.architecture, instance.container ? "容器环境" : ""].filter(Boolean).join(" / ") : "—");
    text("remote-user", instance ? [instance.username, instance.home].filter(Boolean).join(" · ") : "—");
    text("remote-binary", instance?.binary || "未找到程序");
    text("remote-version", instance?.version ? "版本 " + instance.version : instance?.installed ? "版本待核实" : "");
    text("remote-config", instance?.configDirectory || "尚未检测到配置目录");
    const service = instance?.service;
    text("remote-service", !instance?.systemd ? "无 systemd" : !service?.installed ? "尚未安装用户服务" : serviceLabels[service.state] ?? "待核实");
    $("remote-service").className = "badge" + (service?.state === "running" ? " connected" : service?.state === "unknown" ? " connecting" : "");
    text("remote-web-state", instance?.web?.enabled ? "已启用 · 远端端口 " + instance.web.port : "尚未启用");
    const detecting = Boolean(reading?.forced || reading?.queued);
    $("remote-detect").disabled = !sshReady() || detecting || running() || submitting;
    $("remote-detect").title = running() ? "远端任务执行中，页面会自动读取进度；结束后可检测环境。" : "通过 SSH 读取远端环境";
    text("remote-detect-label", detecting ? "正在检测…" : "检测环境");
    showError("remote-error", actionError || readError);
    for (const action of Object.keys(actionLabels)) {
      const button = $("remote-action-" + action), reason = actionReason(action);
      button.disabled = Boolean(reason); button.title = reason || "预览变更后确认执行";
    }
    text("remote-action-hint", baseReason() || (instance?.installed ? "每次变更前会先展示操作预览，确认后交给远端后台执行。" : "安装到当前 SSH 用户的默认位置；安装程序后，可再启用 Web 与用户服务。"));
    text("remote-service-hint", instance && !instance.systemd ? "未检测到 systemd，启停、重启和启用 Web 不可用；程序安装、更新和卸载仍可使用。" : "启用 Web 会配置用户服务；服务启停不会断开 SSH 连接。");
    const reason = webReason();
    $("remote-open-web").disabled = Boolean(reason) || webLoading;
    $("remote-open-web").title = reason || "通过仅监听本机的 SSH 通道生成访问地址";
    text("remote-open-web", webLoading ? "正在建立通道…" : "获取 Web 地址");
    text("remote-web-hint", reason || "远端 Web 默认使用 3430 端口，仅通过本机回环 SSH 通道访问。");
    showError("remote-web-error", webError);
    drawOperation(); syncPreview();
  }

  function drawOperation() {
    $("remote-operation").hidden = !operation && !submissionUncertain && !submitting;
    const state = operation?.state;
    text("remote-operation-title", operation ? (actionLabels[operation.action] ?? "远端任务") : "远端任务");
    text("remote-operation-state", submitting ? "正在提交…" : operationLabels[state] ?? "结果待核实");
    $("remote-operation-state").className = "badge" + (state === "succeeded" ? " connected" : state === "failed" ? " failed" : " connecting");
    text("remote-operation-step", operation?.step ? "当前步骤：" + (stepLabels[operation.step] ?? "处理远端任务") : "");
    const backupDirectory = state === "succeeded" && operation?.action === "update" ? operation.result?.backupDirectory : "";
    text("remote-operation-backup", backupDirectory ? "远端备份目录：" + backupDirectory : "");
    $("remote-operation-backup").hidden = !backupDirectory;
    text("remote-operation-message", submitting ? "请求提交后可关闭预览窗口，任务会在远端后台继续执行。" : operation?.message || (submissionUncertain ? "未能确认任务是否已接收。请先检测环境，避免重复提交。" : ""));
    text("remote-operation-time", operation ? "任务 " + operation.id + " · 更新于 " + time(operation.updatedAt) : "");
    showError("remote-operation-error", operation?.error?.message || "");
    $("remote-operation-unknown").hidden = !uncertain();
  }

  function syncPreview() {
    if (!dialog.open) return;
    dialog.setAttribute("aria-busy", String(previewLoading || submitting));
    $("remote-apply").disabled = !preview || previewLoading || submitting || Boolean(actionReason(previewAction)) || (previewAction === "update" && passphrase.value.length < 12);
    text("remote-apply", submitting ? "正在提交…" : previewAction ? "确认" + actionLabels[previewAction] : "确认执行");
    passphrase.disabled = submitting;
    $("remote-show-passphrase").disabled = submitting;
  }

  function syncPolling() {
    const enabled = !closed && active && row && online && !document.hidden;
    if (!enabled && polling) { clearInterval(polling); polling = null; }
    if (enabled && !polling) polling = setInterval(() => { void refresh(); }, 2000);
  }

  function render(nextRow, options) {
    if (closed) return;
    const changed = row?.connection.id !== nextRow?.connection.id;
    const wasReady = sshReady(), wasActive = active, wasOnline = online;
    if (changed) {
      generation++; dataRevision++; reading = null;
      status = null; operation = null; readError = actionError = ""; submissionUncertain = false; uncertainSubmission = null; submitting = false;
      closePreview(); clearWeb(); $("remote-web-port").value = "3430";
    }
    row = nextRow ?? null; online = Boolean(options.online); active = Boolean(options.active);
    if ((wasReady && !sshReady()) || (!active && wasActive)) closePreview();
    if (!sshReady()) clearWeb();
    draw(); syncPolling();
    if (active && (changed || !wasActive || (!wasOnline && online) || (!wasReady && sshReady()))) void refresh();
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
              operation = result.operation;
              if (!submissionUncertain || (operation.action === uncertainSubmission?.action && operation.revision === uncertainSubmission?.revision)) {
                submissionUncertain = false; uncertainSubmission = null;
              }
            }
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
        if (current(id, epoch) && reading === owner) { reading = null; draw(); }
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

  async function openPreview(action) {
    if (actionReason(action) || dialog.open) return;
    const id = row.connection.id, epoch = generation, sequence = ++previewSequence;
    preview = null; previewAction = action; previewLoading = true;
    clearPassphrase(); actionError = "";
    text("remote-preview-title", "预览" + actionLabels[action]);
    text("remote-preview-connection", row.connection.name + " · " + row.connection.username + "@" + row.connection.host);
    text("remote-preview-summary", "正在读取远端变更预览…");
    list("remote-preview-changes", []); list("remote-preview-warnings", []);
    $("remote-passphrase-field").hidden = true;
    showError("remote-preview-error", "");
    $("remote-preview-background").hidden = true;
    dialog.showModal(); draw();
    try {
      const result = await call("remote_preview", { connectionId: id, action });
      if (!current(id, epoch) || sequence !== previewSequence || !dialog.open) return;
      if (result?.connectionId !== id || result.action !== action) throw new Error("操作预览与当前连接不匹配，请关闭后重试。");
      preview = result;
      text("remote-preview-summary", result.summary);
      list("remote-preview-changes", result.changes); list("remote-preview-warnings", result.warnings);
      $("remote-passphrase-field").hidden = action !== "update";
      passphrase.required = action === "update";
      if (action === "update") passphrase.focus();
    } catch (error) {
      if (current(id, epoch) && sequence === previewSequence && dialog.open) showError("remote-preview-error", errorMessage(error));
    } finally {
      if (current(id, epoch) && sequence === previewSequence) { previewLoading = false; draw(); }
    }
  }

  async function applyPreview(event) {
    event.preventDefault();
    if (!preview || submitting || actionReason(previewAction)) return;
    if (previewAction === "update" && !passphrase.reportValidity()) return;
    const id = row.connection.id, epoch = generation, action = previewAction, revision = preview.revision;
    const credentials = action === "update" ? { backupPassphrase: passphrase.value } : undefined;
    submitting = true; pendingSubmissions.add(id); dataRevision++;
    clearPassphrase(); showError("remote-preview-error", "");
    $("remote-preview-background").hidden = false;
    clearWeb(); draw();
    try {
      const result = await call("remote_apply", { connectionId: id, action, revision }, credentials);
      if (!current(id, epoch)) return;
      if (!result || (result.connectionId && result.connectionId !== id)) throw new Error("未能核实远端任务，请检测环境确认结果。");
      operation = result; submissionUncertain = false; uncertainSubmission = null;
      closePreview(); toast("远端任务已提交，可在远程 Magpie 页查看进度。");
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
      if (!current(id, epoch) || sequence !== webSequence || !sshReady()) return;
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

  for (const action of Object.keys(actionLabels)) $("remote-action-" + action).addEventListener("click", () => { void openPreview(action); });
  $("remote-detect").addEventListener("click", () => { void refresh({ force: true }); });
  $("remote-open-web").addEventListener("click", () => { void openWeb(); });
  $("remote-web-port").addEventListener("input", () => { clearWeb(); draw(); });
  $("remote-web-url").addEventListener("click", (event) => event.currentTarget.select());
  $("remote-hide-web").addEventListener("click", () => { clearWeb(); draw(); });
  dialog.querySelectorAll(".remote-close-preview").forEach((button) => button.addEventListener("click", () => { closePreview(); draw(); }));
  dialog.addEventListener("close", () => { if (!dialog.open) { closePreview(); draw(); } });
  dialog.addEventListener("cancel", () => { clearPassphrase(); });
  $("remote-preview-form").addEventListener("submit", (event) => { void applyPreview(event); });
  $("remote-apply").addEventListener("click", (event) => { void applyPreview(event); });
  $("remote-preview-form").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing && event.target === passphrase) {
      event.preventDefault(); if (!$("remote-apply").disabled) $("remote-apply").click();
    }
  });
  passphrase.addEventListener("input", syncPreview);
  $("remote-show-passphrase").addEventListener("click", () => {
    const visible = passphrase.type === "password";
    passphrase.type = visible ? "text" : "password";
    $("remote-show-passphrase").setAttribute("aria-pressed", String(visible));
    text("remote-show-passphrase", visible ? "隐藏口令" : "显示口令");
  });
  function visibilityChanged() { syncPolling(); if (!document.hidden) void refresh(); }
  document.addEventListener("visibilitychange", visibilityChanged);

  function close() {
    if (closed) return;
    closePreview(); clearWeb(); clearPassphrase();
    closed = true; generation++; reading = null;
    if (polling) { clearInterval(polling); polling = null; }
    document.removeEventListener("visibilitychange", visibilityChanged);
  }
  return { render, refresh, close };
}
