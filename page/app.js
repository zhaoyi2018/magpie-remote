import { icon, renderIcons, setIcon } from "./icons.js";
import { connectionGuidance, launcherURL, managementFailure, readResponse } from "./recovery.js";
import { createBackupManager } from "./backups.js";
import { createRemoteManager } from "./remote.js";

(() => {
  const $ = (id) => document.getElementById(id);
  const tabs = ["forwards", "remote", "connection", "logs"];
  const state = { rows: [], selected: null, online: false, filter: "all", tab: "forwards", busy: new Map(), errors: new Map(), cancelled: new Set() };
  const base = new URL("./", location.href);
  const token = base.pathname.split("/")[1];
  let refreshing;
  let listCollapsed = isNarrow();
  let editingForwardConnection = null;
  let editingForwardId = null;
  let editingForwardSaved = false;
  let editingForwardRevision = null;
  let forwardSaving = false;
  let credentialConnection = null;
  let menuTrigger = null;
  let toastTimer;
  let listSignature, forwardSignature, settingsSignature, logSignature;
  let importPreview = null, previewPath = "", previewSequence = 0, importing = false;
  let serviceFailure = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  renderIcons();
  function button(label, action, className = "text-button", disabled = false) {
    const node = element("button", className, label);
    node.type = "button"; node.disabled = disabled;
    node.addEventListener("click", action);
    return node;
  }
  function toast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message; $("toast").hidden = false;
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 3200);
  }
  function selected() { return state.rows.find((row) => row.connection.id === state.selected); }
  function recovering(session) { return ["waiting", "connecting"].includes(session?.reconnect?.state); }
  function active(session) { return ["connected", "connecting", "reconnecting"].includes(session.state) || recovering(session); }
  function endpoint(host, port) { return (host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host) + ":" + port; }
  function address(connection) { return connection.username + "@" + endpoint(connection.host, connection.port); }
  function auth(connection) {
    if (connection.authMethod === "password") return "密码";
    if (connection.authMethod === "agent") return "SSH agent";
    if (connection.authMethod === "key") return "私钥文件";
    if (connection.authMethod === "environment") return connection.passwordEnv ? "密码环境变量" : "登录密码";
    return connection.identityFile ? "私钥文件" : connection.agent ? "SSH agent" : connection.passwordEnv ? "密码环境变量" : "登录密码 / 宿主 agent";
  }
  function uniqueId(prefix) { return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7); }
  const labels = { reconnecting: "等待重连", connecting: "连接中", connected: "已连接", disconnected: "未连接", failed: "连接失败", listening: "运行中", starting: "启动中", stopping: "停止中", stopped: "已停止" };
  function viewState(row) {
    const busy = state.busy.get(row.connection.id);
    if (row.session.reconnect?.state === "waiting" && busy?.name !== "connect") return "reconnecting";
    return busy?.name === "connect" && row.session.state !== "connected" ? "connecting" : row.session.state;
  }
  function visibleRows() {
    const query = $("search").value.trim().toLowerCase();
    return state.rows.filter((row) => {
      const status = viewState(row);
      return (row.connection.name + " " + address(row.connection)).toLowerCase().includes(query)
        && (state.filter === "all" || (state.filter === "connected" ? status === "connected" : status !== "connected"));
    });
  }
  function reconcileSelection() {
    const rows = visibleRows();
    if (!rows.some((row) => row.connection.id === state.selected)) {
      state.selected = rows[0]?.connection.id ?? null;
      setTab("forwards");
      $("connection-detail").scrollTop = 0;
    }
  }
  function pick(row) {
    hideMenu();
    state.selected = row.connection.id;
    if (isNarrow()) listCollapsed = true;
    setTab("forwards"); render();
    $("connection-detail").scrollTop = 0;
    if (isNarrow()) $("toggle-list").focus();
  }
  function isNarrow() { return matchMedia("(max-width: 760px)").matches; }
  function applyLayout() {
    const collapsed = isNarrow() && listCollapsed && Boolean(selected());
    $("app-layout").classList.toggle("list-collapsed", collapsed);
    $("narrow-bar").hidden = !(isNarrow() && selected());
    $("toggle-list").setAttribute("aria-expanded", String(!collapsed));
    $("toggle-list").textContent = collapsed ? "连接列表" : "收起列表";
    $("narrow-current").textContent = selected()?.connection.name ?? "";
  }

  async function request(path, options = {}, timeout = 50000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(new URL(path, base), { ...options, credentials: "omit", signal: controller.signal, headers: { Authorization: "Bearer " + token, ...options.headers } });
      return await readResponse(response);
    } catch (error) {
      if (error.name === "AbortError") throw Object.assign(new Error("请求超时，请检查连接状态后重试"), { code: "REQUEST_TIMEOUT" });
      if (error instanceof TypeError) throw Object.assign(new Error("无法连接管理服务"), { code: "SERVICE_UNREACHABLE" });
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function call(method, args = {}, credentials) {
    return (await request("api/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, args, ...(credentials && { credentials }) }) })).result;
  }
  async function refresh(force = false) {
    if (refreshing) {
      if (force) { await refreshing; return refresh(); }
      return refreshing;
    }
    refreshing = (async () => {
      try {
        const snapshot = await request("api/snapshot", {}, 5000);
        state.rows = snapshot.connections; state.online = true; serviceFailure = null;
        $("storage-warning").textContent = snapshot.storageWarning?.message ?? "";
        $("storage-warning").hidden = !snapshot.storageWarning;
        reconcileSelection();
        $("last-updated").textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
        $("service-error").hidden = true;
      } catch (error) {
        state.online = false; $("service-error").hidden = false;
        serviceFailure = managementFailure(error);
        $("service-error-message").textContent = serviceFailure.message;
        $("reopen").textContent = serviceFailure.action === "retry" ? "重试读取" : "重新打开";
        $("last-updated").textContent = "当前显示最后读取的状态";
      }
      $("service-state").textContent = state.online ? "管理服务在线" : serviceFailure.label;
      $("service-state").className = "service-state " + (state.online ? "is-online" : "is-offline");
      render();
    })();
    try { await refreshing; } finally { refreshing = null; }
  }
  async function run(id, name, operation, message) {
    const owner = Symbol();
    let failure;
    state.busy.set(id, { owner, name }); state.errors.delete(id); render();
    try {
      await operation();
      if (message) toast(message);
    } catch (error) {
      failure = error;
      if (!(name === "connect" && state.cancelled.has(id))) {
        state.errors.set(id, { message: error.message, code: error.code, category: error.category });
        if (state.selected !== id) toast(error.message);
      }
    } finally {
      if (state.busy.get(id)?.owner === owner) state.busy.delete(id);
      await refresh(true);
    }
    return failure;
  }
  function render() {
    if ($("forward-editor").open) syncForwardAction();
    $("new-connection").disabled = $("empty-add").disabled = $("import-config").disabled = !state.online;
    $("open-backups").disabled = serviceFailure?.action === "reopen";
    const connected = state.rows.filter((row) => row.session.state === "connected").length;
    const running = state.rows.reduce((sum, row) => sum + row.session.forwards.filter((rule) => rule.state === "listening").length, 0);
    for (const [id, count] of [["connected-count", connected], ["running-count", running]]) {
      if ($(id).textContent !== String(count)) $(id).textContent = count;
    }
    $("summary-dot").classList.toggle("is-live", connected > 0);
    $("connection-count").textContent = state.rows.length;
    document.querySelectorAll("[data-filter]").forEach((node) => node.setAttribute("aria-pressed", String(node.dataset.filter === state.filter)));
    renderConnections();
    const row = selected();
    $("empty-state").hidden = Boolean(row); $("connection-detail").hidden = !row;
    $("empty-state").querySelector("h2").textContent = state.rows.length ? "没有匹配的连接" : "从一条 SSH 连接开始";
    $("empty-state").querySelector("p").textContent = state.rows.length ? "试试其他名称、主机地址，或清除当前筛选。" : "添加服务器，或导入已有 SSH 配置。连接后即可管理本地与远程端口转发。";
    $("empty-reset").hidden = !state.rows.length;
    $("empty-add").hidden = Boolean(state.rows.length);
    $("empty-directions").hidden = Boolean(state.rows.length);
    $("last-connected").textContent = "尚未建立连接";
    applyLayout();
    remote.render(row ?? null, { online: state.online, active: state.tab === "remote" });
    if (!row) return;
    const { connection, session } = row;
    const busy = state.busy.get(connection.id);
    const status = viewState(row);
    $("detail-name").textContent = connection.name;
    $("detail-address").textContent = endpoint(connection.host, connection.port);
    $("detail-user").textContent = connection.username;
    $("detail-auth").textContent = auth(connection);
    $("connection-route").dataset.state = state.online ? status : "unknown";
    $("route-status").textContent = !state.online ? "状态待同步" : {
      connected: "会话已建立", connecting: "正在建立连接…", reconnecting: "网络中断，等待重连", failed: "连接失败，请重试", disconnected: "尚未建立连接",
    }[status] ?? labels[status] ?? status;
    $("panel-forwards").querySelector(".info-note p").textContent = connection.autoStartForwards === false
      ? "当前已关闭自动启动预设，请手动启动所需转发；SSH 断开时会自动释放监听端口。"
      : "连接认证成功后启动预设转发；SSH 断开时会自动释放监听端口。";
    $("detail-state").className = "badge " + status;
    $("detail-state").textContent = labels[status] ?? status;
    $("connect-label").textContent = busy?.name === "connect" ? (session.state === "connected" ? "正在重连…" : "正在连接…") : status === "connected" ? "重新连接" : status === "reconnecting" ? "立即重试" : "连接服务器";
    $("connect").classList.toggle("primary", status !== "connected");
    $("connect").disabled = !state.online || status === "connecting" || Boolean(busy);
    $("disconnect").disabled = !state.online || !active({ state: status }) || (Boolean(busy) && busy.name !== "connect");
    $("disconnect-label").textContent = status === "reconnecting" || (status === "connecting" && session.reconnect?.attempts > 0) ? "停止重连" : status === "connecting" || busy?.name === "connect" ? "取消连接" : "断开连接";
    $("credentials-connect").disabled = !state.online || active({ state: status }) || Boolean(busy);
    $("edit-connection").disabled = $("delete-connection").disabled = !state.online || active(session) || Boolean(busy);
    $("new-forward").disabled = $("empty-forward").disabled = !state.online || Boolean(busy) || recovering(session);
    const retry = session.reconnect;
    $("reconnect-status").hidden = !["waiting", "paused"].includes(retry?.state) && !(retry?.state === "connecting" && retry.attempts > 0);
    $("reconnect-status").textContent = retry?.state === "waiting" ? `第 ${retry.attempts} 次重连将在 ${new Date(retry.nextRetryAt).toLocaleTimeString("zh-CN", { hour12: false })} 尝试；可随时停止。`
      : retry?.state === "paused" ? "自动重连已暂停：" + retry.reason + "。处理后请手动连接。"
      : `正在进行第 ${retry?.attempts ?? 0} 次重连…`;
    const error = state.errors.get(connection.id) ?? (session.state === "failed" ? session.error ?? { message: session.lastError } : null);
    $("operation-error").textContent = error?.message ?? ""; $("operation-error").hidden = !error?.message;
    const guidance = connectionGuidance(error, connection);
    $("connection-guidance").textContent = guidance; $("connection-guidance").hidden = !guidance;
    const last = session.connectedAt ?? session.lastConnectedAt;
    $("last-connected").textContent = last ? "最近连接 " + new Date(last).toLocaleString("zh-CN", { hour12: false }) : "尚未建立连接";
    updateDuration(); renderForwards(row, Boolean(busy)); renderSettings(row); renderLogs(row);
  }
  function renderConnections() {
    const rows = visibleRows();
    const signature = JSON.stringify([rows.map((row) => [row.connection, viewState(row), state.busy.has(row.connection.id)]), state.selected, state.online]);
    if (signature === listSignature) return;
    listSignature = signature; hideMenu();
    $("connection-list").replaceChildren();
    for (const row of rows) {
      const { connection } = row;
      const status = viewState(row);
      const wrapper = element("div", "connection-row" + (connection.id === state.selected ? " is-selected" : ""));
      const card = button("", () => pick(row), "connection-card");
      card.setAttribute("aria-current", String(connection.id === state.selected));
      card.setAttribute("aria-label", connection.name + "，" + address(connection) + "，" + (labels[status] ?? status));
      const body = element("div", "card-body");
      const title = element("div", "card-title");
      const name = element("span", "card-name", connection.name); name.title = connection.name;
      title.append(name, element("span", "badge " + status, labels[status] ?? status));
      const host = element("div", "card-address", address(connection)); host.title = address(connection);
      const glyph = element("span", "connection-glyph"); glyph.append(icon("server"));
      body.append(title, host); card.append(glyph, body);
      const more = button("", (event) => openMenu(row, event.currentTarget), "icon-button");
      more.append(icon("more")); more.setAttribute("aria-label", connection.name + "的更多操作");
      more.setAttribute("aria-expanded", "false"); more.setAttribute("aria-controls", "connection-menu");
      wrapper.append(card, more); $("connection-list").append(wrapper);
    }
    if (!rows.length) $("connection-list").append(element("p", "no-matches", state.rows.length ? "没有匹配的连接" : "尚未添加连接"));
  }
  function renderForwards({ connection, revision, session }, busy) {
    const signature = JSON.stringify([connection.id, revision, connection.forwards, session.forwards, session.forwardErrors, session.state, session.reconnect?.state, busy, state.online]);
    if (signature === forwardSignature) return;
    forwardSignature = signature;
    const rules = new Map(connection.forwards.map((rule) => [rule.id, { ...rule, saved: true, state: "stopped" }]));
    for (const error of session.forwardErrors ?? []) {
      const rule = rules.get(error.id);
      if (rule) { rule.state = "failed"; rule.lastError = error.message; }
    }
    for (const live of session.forwards) rules.set(live.id, { ...rules.get(live.id), ...live });
    $("forward-list").replaceChildren();
    $("forward-count").textContent = rules.size;
    $("forward-empty").hidden = rules.size > 0;
    $("forward-list").closest(".table-wrap").hidden = rules.size === 0;
    for (const rule of rules.values()) {
      const tr = element("tr");
      const name = element("td", "rule-name");
      name.append(element("span", "rule-title", rule.name ?? rule.id));
      const local = rule.direction === "c2s";
      const direction = element("span", "direction-tag", local ? "本地转发 (-L)" : "远程转发 (-R)");
      direction.prepend(icon(local ? "laptop" : "server"));
      name.append(direction);
      if (!rule.saved) name.append(element("span", "temporary-tag", "临时规则"));
      const path = element("td", "rule-path");
      const route = element("div", "rule-route");
      const listener = element("div", "rule-endpoint"), target = element("div", "rule-endpoint");
      listener.append(element("span", "endpoint-label", local ? "本机监听" : "服务器监听"), element("span", "endpoint", endpoint(rule.bindHost, rule.bindPort)));
      target.append(element("span", "endpoint-label", local ? "服务器目标" : "本机目标"), element("span", "endpoint", endpoint(rule.targetHost, rule.targetPort)));
      const arrow = element("span", "rule-route-arrow"); arrow.append(icon("arrow"));
      arrow.append(element("span", "sr-only", "转发至"));
      route.append(listener, arrow, target); path.append(route);
      const status = element("td");
      status.append(element("span", "badge " + rule.state, rule.state === "failed" ? "启动失败" : rule.state === "listening" ? "监听中" : labels[rule.state] ?? rule.state));
      if (rule.targetConnection) {
        const target = rule.targetConnection;
        status.append(element("div", "target-result", { unknown: "目标：尚无连接请求", connecting: "目标：正在建立连接", succeeded: "目标：最近连接成功", failed: "目标：最近连接异常" }[target.state] ?? target.state));
        for (const [key, label] of [["lastAttemptAt", "尝试"], ["lastFailureAt", "失败"], ["lastSuccessAt", "成功"]]) {
          if (!target[key]) continue;
          const time = element("time", "target-time", label + " " + new Date(target[key]).toLocaleTimeString("zh-CN", { hour12: false }));
          time.dateTime = target[key]; time.title = new Date(target[key]).toLocaleString("zh-CN", { hour12: false });
          status.append(time);
        }
      }
      if (rule.lastError) status.append(element("div", "row-error", rule.lastError));
      const actions = element("td"), actionsBox = element("div", "rule-actions");
      const running = session.forwards.some((item) => item.id === rule.id);
      const enabled = state.online && !busy && !recovering(session);
      if (running) actionsBox.append(button("停止", () => run(connection.id, "stop-forward", () => call("forward_remove", { connectionId: connection.id, forwardId: rule.id }), "转发已停止"), "text-button", !enabled));
      else {
        const start = button("启动", () => run(connection.id, "start-forward", () => call("forward_add", { connectionId: connection.id, forward: connection.forwards.find((item) => item.id === rule.id) }), "转发已启动"), "text-button", !enabled || session.state !== "connected");
        if (session.state !== "connected") start.title = "请先建立 SSH 连接";
        actionsBox.append(start);
      }
      const edit = button("编辑", () => openForward(rule), "text-button", !enabled || running || !rule.saved);
      edit.title = running ? "先停止这条转发再编辑" : rule.saved ? "编辑转发规则" : "临时转发没有保存的预设";
      const remove = button("", async () => {
        if (await confirmAction("删除转发规则", "删除「" + (rule.name ?? rule.id) + "」的预设；正在运行的转发也会停止。")) {
          await run(connection.id, "delete-forward", () => call("forward_delete", { connectionId: connection.id, forwardId: rule.id, expectedRevision: revision }), "转发规则已删除");
        }
      }, "icon-button", !enabled);
      remove.append(icon("trash")); remove.title = "删除规则"; remove.setAttribute("aria-label", "删除转发 " + (rule.name ?? rule.id));
      actionsBox.append(edit, remove); actions.append(actionsBox);
      tr.append(name, path, status, actions);
      $("forward-list").append(tr);
    }
  }
  function renderSettings({ connection, session }) {
    const signature = JSON.stringify([connection, session.hostFingerprint]);
    if (settingsSignature === signature) return;
    settingsSignature = signature;
    const values = [["连接标识", connection.id], ["服务器地址", endpoint(connection.host, connection.port)], ["用户名", connection.username], ["认证方式", auth(connection)], ["自动启动预设", connection.autoStartForwards === false ? "已关闭" : "已开启"], ["预设失败处理", connection.forwardFailurePolicy === "continue" ? "保留连接，继续其他预设" : "回滚本次连接"], ["启动时连接", connection.autoConnect ? "已开启" : "已关闭"], ["私钥路径", connection.identityFile], ["Agent 地址", connection.agent], ["密码环境变量", connection.passwordEnv], ["私钥口令变量", connection.passphraseEnv], ["主机指纹", connection.hostFingerprint ?? session.hostFingerprint ?? "使用 known_hosts 校验"], ["known_hosts", connection.knownHostsFile ?? "~/.ssh/known_hosts"]];
    $("settings-list").replaceChildren();
    values.splice(7, 0, ["断网自动重连", connection.autoReconnect ? "已开启，仅网络故障重试" : "已关闭"]);
    for (const [label, value] of values) {
      if (!value) continue;
      const row = element("div", "settings-row");
      row.append(element("dt", "", label), element("dd", "", value)); $("settings-list").append(row);
    }
  }
  function renderLogs({ connection, session }) {
    const filter = $("log-filter").value;
    const logs = (session.logs ?? []).filter((item) => filter === "all" || item.level === "error").slice().reverse();
    const signature = JSON.stringify([connection.id, filter, logs]);
    if (logSignature === signature) return;
    logSignature = signature; $("log-list").replaceChildren();
    for (const log of logs) {
      const row = element("div", "log-row " + log.level);
      const time = element("time", "", new Date(log.time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }));
      time.dateTime = log.time;
      row.append(time, element("span", "log-level", { info: "信息", warn: "提示", error: "错误" }[log.level] ?? log.level), element("span", "log-message", log.message));
      $("log-list").append(row);
    }
    if (!logs.length) $("log-list").append(element("p", "no-matches", filter === "error" ? "暂无错误日志" : "暂无运行日志，连接后会在这里记录 SSH、转发与远程 Magpie 事件。"));
  }
  function updateDuration() {
    const session = selected()?.session;
    if (session?.state !== "connected" || !session.connectedAt) { $("connection-time").textContent = "—"; return; }
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(session.connectedAt)) / 1000));

    $("connection-time").textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, "0")).join(":");
  }
  function setTab(tab, focus = false) {
    state.tab = tab;
    for (const name of tabs) {
      $("tab-" + name).setAttribute("aria-selected", String(tab === name));
      $("tab-" + name).tabIndex = tab === name ? 0 : -1;
      $("panel-" + name).hidden = tab !== name;
    }
    remote.render(selected() ?? null, { online: state.online, active: tab === "remote" });
    if (focus) $("tab-" + tab).focus();
  }
  function hideMenu(restoreFocus = false) {
    $("connection-menu").hidden = true;
    menuTrigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus) menuTrigger?.focus();
    menuTrigger = null;
  }
  function openMenu(row, trigger) {
    if (menuTrigger === trigger && !$("connection-menu").hidden) { hideMenu(true); return; }
    hideMenu(); menuTrigger = trigger; trigger.setAttribute("aria-expanded", "true");
    const { connection, session } = row;
    const disabled = !state.online || state.busy.has(connection.id);
    const menu = $("connection-menu"); menu.replaceChildren();
    menu.append(
      button(session.state === "connected" ? "重新连接" : "连接服务器", () => { hideMenu(); pick(row); beginConnect(row); }, "", disabled || session.state === "connecting"),
      button("连接设置", () => { hideMenu(); pick(row); setTab("connection"); }, ""),
      button("编辑连接", () => { hideMenu(); openConnection(connection); }, "", disabled || active(session)),
      button("删除连接", () => { hideMenu(); void deleteConnection(row); }, "danger", disabled || active(session))
    );
    menu.hidden = false;
    const rect = trigger.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(rect.right - 152, innerWidth - 160)) + "px";
    menu.style.top = Math.max(8, Math.min(rect.bottom + 5, innerHeight - menu.offsetHeight - 8)) + "px";
    menu.querySelector("button:not(:disabled)")?.focus();
  }

  function validateInputs(ids) {
    for (const id of ids) {
      if (!$(id).checkValidity()) {
        const details = $(id).closest("details"); if (details) details.open = true;
        $(id).reportValidity(); throw new Error("请检查必填字段和端口范围");
      }
    }
  }
  const connectionEditor = window.createSSHConnectionEditor({
    getRows: () => state.rows, isOnline: () => state.online, call,
    async onSaved(connection, isNew) {
      $("search").value = ""; state.filter = "all"; state.selected = connection.id;
      toast("连接配置已保存"); await refresh(true); setTab("forwards");
      if (isNew) beginConnect(state.rows.find((row) => row.connection.id === connection.id) ?? { connection, session: { state: "disconnected" } });
    },
  });
  function openConnection(connection) { connectionEditor.open(connection); }
  function beginConnect(row = selected(), withCredentials = false) {
    if (!row || !state.online || state.busy.has(row.connection.id) || row.session.state === "connecting") return;
    if (withCredentials) { showCredentials(row); return; }
    void connectTo(row.connection.id);
  }
  function showCredentials(row, error) {
    const { connection } = row;
    const fields = error?.credentialFields ?? (connection.identityFile ? ["password", "passphrase"] : ["password"]);
    credentialConnection = connection.id;
    $("credential-title").textContent = row.session.state === "connected" ? "重新连接服务器" : "连接服务器";
    $("credential-address").textContent = connection.name + " · " + address(connection);
    $("credential-hint").textContent = error?.message ?? "填写本次需要的登录凭据。";
    for (const field of ["password", "passphrase"]) {
      const input = $("login-" + field);
      input.value = "";
      input.closest("label").hidden = !fields.includes(field);
      input.required = fields.length === 1 && fields.includes(field);
    }
    $("credential-dialog").showModal();
    $("login-" + (fields.includes("passphrase") && connection.identityFile ? "passphrase" : "password")).focus();
  }
  async function connectTo(id, credentials) {
    state.cancelled.delete(id);
    const error = await run(id, "connect", async () => {
      if (state.rows.find((row) => row.connection.id === id)?.session.state === "connected") await call("disconnect", { connectionId: id });
      if (state.cancelled.has(id)) return;
      await call("connect", { connectionId: id }, credentials);
    }, "");
    if (error?.code === "CREDENTIALS_REQUIRED" && !state.cancelled.has(id) && state.online
      && state.selected === id && !document.querySelector("dialog[open]")) {
      const row = state.rows.find((item) => item.connection.id === id);
      if (row) showCredentials(row, error);
    }
    if (!state.cancelled.has(id) && state.rows.find((row) => row.connection.id === id)?.session.state === "connected") toast("SSH 连接成功");
  }
  async function deleteConnection(row = selected()) {
    if (row && await confirmAction("删除 SSH 连接", "删除「" + row.connection.name + "」及其全部转发预设。")) {
      await run(row.connection.id, "delete", () => call("remove_connection", { connectionId: row.connection.id, expectedRevision: row.revision }), "连接已删除");
    }
  }
  function rulePreview() {
    const local = $("rule-direction-c2s").checked;
    $("rule-listener-text").textContent = local ? "本机监听" : "远程监听";
    $("rule-relay-text").textContent = local ? "SSH 服务器" : "SSH 客户端";
    $("rule-target-text").textContent = local ? "远程目标" : "本机目标";
    setIcon($("rule-listener-icon"), local ? "laptop" : "server");
    setIcon($("rule-relay-icon"), local ? "server" : "laptop");
    $("rule-preview").setAttribute("aria-label", local ? "本机监听，经 SSH 服务器转发至远程目标" : "远程监听，经 SSH 客户端转发至本机目标");
    $("rule-hint").textContent = local ? "本地转发 (-L)：本机监听端口，流量经 SSH 转发至服务器侧目标。" : "远程转发 (-R)：服务器监听端口，流量经 SSH 转发至本机侧目标。";
  }
  function syncForwardAction() {
    $("forward-editor").setAttribute("aria-busy", String(forwardSaving));
    $("forward-editor").querySelectorAll(".close-dialog").forEach((node) => { node.disabled = forwardSaving; });
    const row = state.rows.find((item) => item.connection.id === editingForwardConnection);
    const connected = row?.session.state === "connected";
    if (!connected || editingForwardSaved) $("rule-save-preset").checked = true;
    $("rule-save-preset").disabled = forwardSaving || !connected || editingForwardSaved;
    $("rule-action-hint").hidden = connected;
    $("rule-action-hint").textContent = row?.connection.autoStartForwards === false
      ? "SSH 尚未连接。保存预设后，请先连接服务器，再手动启动转发。"
      : "SSH 尚未连接。预设会在连接成功后自动启动。";
    $("save-forward-icon").hidden = forwardSaving || Boolean(editingForwardId) || !connected;
    $("save-forward-label").textContent = forwardSaving ? "正在保存…" : editingForwardId ? "保存修改" : connected ? "创建并启动" : "保存预设";
    $("save-forward").disabled = forwardSaving || !state.online || !row || state.busy.has(editingForwardConnection) || recovering(row?.session);
  }
  function openForward(rule) {
    if (forwardSaving) return;
    editingForwardConnection = state.selected; editingForwardId = rule?.id ?? null;
    editingForwardRevision = selected()?.revision ?? null;
    editingForwardSaved = Boolean(rule);
    $("forward-editor-title").textContent = rule ? "编辑端口转发" : "新建端口转发";
    const values = { id: rule?.id ?? uniqueId("forward"), name: rule?.name ?? rule?.id ?? "", "bind-host": rule?.bindHost ?? "127.0.0.1", "bind-port": rule?.bindPort ?? "", "target-host": rule?.targetHost ?? "127.0.0.1", "target-port": rule?.targetPort ?? "" };
    for (const [name, value] of Object.entries(values)) $("rule-" + name).value = value;
    $("rule-direction-c2s").checked = rule?.direction !== "s2c";
    $("rule-direction-s2c").checked = rule?.direction === "s2c";
    $("rule-save-preset").checked = true;
    $("rule-error").hidden = true;
    rulePreview(); syncForwardAction(); $("forward-editor").showModal();
  }
  async function saveForward(event) {
    event.preventDefault();
    if (forwardSaving) return;
    forwardSaving = true; syncForwardAction(); $("rule-error").hidden = true;
    let saved = false;
    try {
      validateInputs(["rule-name", "rule-bind-host", "rule-bind-port", "rule-target-host", "rule-target-port"]);
      if (!$("rule-name").value.trim()) throw new Error("请填写规则名称");
      const forward = { id: $("rule-id").value, name: $("rule-name").value.trim(), direction: $("rule-direction-c2s").checked ? "c2s" : "s2c", bindHost: $("rule-bind-host").value.trim(), bindPort: Number($("rule-bind-port").value), targetHost: $("rule-target-host").value.trim(), targetPort: Number($("rule-target-port").value) };
      const row = state.rows.find((item) => item.connection.id === editingForwardConnection);
      if (!row || !state.online) throw new Error("管理服务不可用，请刷新后重试");
      if (state.busy.has(editingForwardConnection)) throw new Error("连接正在处理其他操作，请稍后重试");
      if (!editingForwardId && !editingForwardSaved && (row.connection.forwards.some((rule) => rule.id === forward.id) || row.session.forwards.some((rule) => rule.id === forward.id))) throw new Error("规则标识已存在，请重新打开窗口");
      const start = !editingForwardId && row.session.state === "connected";
      if ($("rule-save-preset").checked || !start) {
        const result = await call("forward_save", { connectionId: editingForwardConnection, forward, expectedRevision: editingForwardRevision });
        editingForwardRevision = result.revision;
        editingForwardSaved = saved = true;
      }
      if (start) await call("forward_add", { connectionId: editingForwardConnection, forward });
      $("forward-editor").close();
      toast(start ? saved ? "转发已创建并启动，预设已保存" : "临时转发已创建并启动" : "转发预设已保存");
      await refresh(true);
    } catch (error) {
      $("rule-error").textContent = saved ? "预设已保存，但启动失败：" + error.message : error.message;
      $("rule-error").hidden = false;
      await refresh(true);
    } finally { forwardSaving = false; syncForwardAction(); }
  }

  function invalidatePreview() {
    previewSequence++; importPreview = null;
    $("confirm-import").disabled = true; $("import-selection").hidden = true;
    $("import-sources").replaceChildren();
    $("import-list").replaceChildren(element("p", "no-matches", "点击「预览配置」读取可用连接。"));
    $("import-error").hidden = $("import-result").hidden = true;
  }
  async function previewImport() {
    invalidatePreview();
    const sequence = previewSequence;
    const path = $("import-path").value.trim();
    $("preview-import").disabled = true; $("preview-import").textContent = "读取中…";
    try {
      const preview = await call("ssh_config_preview", path ? { configPath: path } : {});
      if (sequence !== previewSequence) return;
      importPreview = preview; previewPath = path;
      renderImport();
    } catch (error) {
      if (sequence === previewSequence) { $("import-error").textContent = error.message; $("import-error").hidden = false; }
    } finally {
      $("preview-import").disabled = false; $("preview-import").textContent = "预览配置";
    }
  }
  function renderImport() {
    $("import-sources").replaceChildren();
    for (const file of importPreview.files) $("import-sources").append(element("p", "", (file.exists ? "已读取 " : "未找到 ") + file.path + (file.error ? " · " + file.error : "")));
    $("import-list").replaceChildren();
    for (const candidate of importPreview.candidates) {
      const item = element("div", "import-item");
      const label = element("label", "checkbox-label"), checkbox = element("input");
      checkbox.type = "checkbox"; checkbox.value = candidate.alias;
      checkbox.disabled = !candidate.selectable || candidate.exists;
      checkbox.checked = !checkbox.disabled;
      checkbox.addEventListener("change", updateImportSelection);
      const name = element("span", "", candidate.alias + (candidate.exists ? " · 已存在" : ""));
      if (candidate.profile) name.append(element("span", "import-address", address(candidate.profile) + " · " + auth(candidate.profile) + " · " + candidate.profile.forwards.length + " 条转发"));
      label.append(checkbox, name); item.append(label);
      for (const warning of candidate.warnings ?? []) item.append(element("p", "import-warning", warning));
      for (const error of candidate.errors ?? []) item.append(element("p", "import-item-error", error));
      $("import-list").append(item);
    }
    if (!importPreview.candidates.length) $("import-list").append(element("p", "no-matches", "没有可导入的 Host 配置，可指定其他配置文件后重试。"));
    $("import-selection").hidden = !importPreview.candidates.length; updateImportSelection();
  }
  function updateImportSelection() {
    const checkboxes = [...$("import-list").querySelectorAll("input:not(:disabled)")];
    const checked = checkboxes.filter((node) => node.checked).length;
    $("import-all").checked = checked > 0 && checked === checkboxes.length;
    $("import-all").indeterminate = checked > 0 && checked < checkboxes.length;
    $("import-all").disabled = !checkboxes.length || importing;
    $("import-count").textContent = "已选择 " + checked + " / " + checkboxes.length;
    $("confirm-import").disabled = !checked || !importPreview || importing || !state.online;
  }
  async function importConnections() {
    if (!importPreview || importing) return;
    const aliases = [...$("import-list").querySelectorAll("input:checked:not(:disabled)")].map((node) => node.value);
    if (!aliases.length) return;
    importing = true; updateImportSelection();
    $("import-path").disabled = $("preview-import").disabled = $("import-forwards").disabled = true;
    $("import-list").querySelectorAll("input").forEach((node) => { node.disabled = true; });
    $("confirm-import").textContent = "正在导入…"; $("import-error").hidden = $("import-result").hidden = true;
    try {
      const result = await call("ssh_config_import", { ...(previewPath && { configPath: previewPath }), revision: importPreview.revision, aliases, includeForwards: $("import-forwards").checked });
      const first = result.imported[0];
      if (first) { $("search").value = ""; state.filter = "all"; state.selected = first.id; }
      await refresh(true);
      $("import-result").textContent = "已导入 " + result.imported.length + " 个连接" + (result.skipped.length ? "，跳过 " + result.skipped.length + " 个已有连接" : "") + "，未自动连接。";
      $("import-result").hidden = false;
      for (const candidate of importPreview.candidates) if (state.rows.some((row) => row.connection.id === candidate.profile?.id)) candidate.exists = true;
      toast("配置导入完成");
    } catch (error) { $("import-error").textContent = error.message; $("import-error").hidden = false; }
    finally {
      importing = false;
      $("import-path").disabled = $("preview-import").disabled = $("import-forwards").disabled = false;
      $("confirm-import").textContent = "导入选中连接";
      if (importPreview) renderImport();
    }
  }
  function confirmAction(title, description, acceptLabel = "确认删除") {
    $("confirm-title").textContent = title; $("confirm-description").textContent = description;
    $("confirm-accept").textContent = acceptLabel;
    const dialog = $("confirm-dialog"); dialog.returnValue = "";
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true }); dialog.showModal();
    });
  }

  const reset = button("清除筛选", () => { $("search").value = ""; state.filter = "all"; reconcileSelection(); render(); }, "button");
  reset.id = "empty-reset"; reset.hidden = true;
  $("empty-add").after(reset);
  for (const form of ["connection-form", "forward-form"]) $(form).noValidate = true;
  $("confirm-cancel").addEventListener("click", () => $("confirm-dialog").close("cancel"));
  $("confirm-accept").addEventListener("click", () => $("confirm-dialog").close("yes"));
  document.querySelectorAll(".close-dialog").forEach((node) => node.addEventListener("click", () => node.closest("dialog").close()));
  for (const id of ["new-connection", "empty-add"]) $(id).addEventListener("click", () => openConnection());
  for (const id of ["new-forward", "empty-forward"]) $(id).addEventListener("click", () => openForward());
  $("edit-connection").addEventListener("click", () => { if (selected()) openConnection(selected().connection); });
  function bindForm(id, submit) {
    const form = $(id);
    const action = form.querySelector('button[type="submit"]');
    form.addEventListener("submit", submit);
    // The management page's CSP sandbox blocks native form submission, including
    // its submit event. Route button and Enter actions through JavaScript instead.
    action.addEventListener("click", submit);
    form.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing || !event.target.matches('input:not([type="checkbox"])')) return;
      event.preventDefault();
      if (!action.disabled) action.click();
    });
  }
  $("forward-editor").addEventListener("cancel", (event) => { if (forwardSaving) event.preventDefault(); });
  $("forward-form").addEventListener("submit", saveForward);
  $("save-forward").addEventListener("click", saveForward);
  $("forward-form").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing && event.target.matches("input:not([type=radio]):not([type=checkbox])")) {
      void saveForward(event);
    }
  });
  for (const direction of ["c2s", "s2c"]) $("rule-direction-" + direction).addEventListener("change", rulePreview);
  $("search").addEventListener("input", () => { reconcileSelection(); render(); });
  document.querySelectorAll("[data-filter]").forEach((node) => node.addEventListener("click", () => { state.filter = node.dataset.filter; reconcileSelection(); render(); }));
  $("refresh").addEventListener("click", async () => { await refresh(); void remote.refresh({ force: true }); });
  for (const tab of tabs) {
    $("tab-" + tab).addEventListener("click", () => setTab(tab));
    $("tab-" + tab).addEventListener("keydown", (event) => {
      let index = tabs.indexOf(tab);
      if (event.key === "ArrowRight") index = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") index = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") index = 0;
      else if (event.key === "End") index = tabs.length - 1;
      else return;
      event.preventDefault(); setTab(tabs[index], true);
    });
  }
  $("log-filter").addEventListener("change", () => { if (selected()) renderLogs(selected()); });
  $("toggle-list").addEventListener("click", () => {
    listCollapsed = !$("app-layout").classList.contains("list-collapsed"); applyLayout();
    if (!listCollapsed) $("search").focus();
  });
  matchMedia("(max-width: 760px)").addEventListener("change", () => { listCollapsed = isNarrow(); applyLayout(); });
  $("connect").addEventListener("click", () => beginConnect());
  $("credentials-connect").addEventListener("click", () => beginConnect(selected(), true));
  bindForm("credential-form", (event) => {
    event.preventDefault();
    if (!$("credential-form").reportValidity()) return;
    const id = credentialConnection;
    const credentials = { password: $("login-password").value, passphrase: $("login-passphrase").value };
    $("credential-dialog").close();
    if (id && state.online && state.rows.some((row) => row.connection.id === id)) void connectTo(id, credentials);
  });
  $("credential-dialog").addEventListener("close", () => {
    // A previous close event may arrive after a fast failure reopens the dialog.
    if ($("credential-dialog").open) return;
    $("login-password").value = $("login-passphrase").value = "";
    credentialConnection = null;
  });
  $("disconnect").addEventListener("click", () => {
    const id = state.selected; if (!id) return;
    state.cancelled.add(id);

    void run(id, "disconnect", () => call("disconnect", { connectionId: id }), "SSH 连接已断开");
  });
  $("delete-connection").addEventListener("click", () => void deleteConnection());
  $("import-config").addEventListener("click", () => { $("import-dialog").showModal(); if (!importPreview) void previewImport(); });
  const backups = createBackupManager({ call, refresh, toast, confirmAction });
  const remote = createRemoteManager({ call, confirmAction, toast });
  $("open-backups").addEventListener("click", () => backups.open());
  $("preview-import").addEventListener("click", () => void previewImport());
  $("import-path").addEventListener("input", invalidatePreview);
  $("import-all").addEventListener("change", () => { $("import-list").querySelectorAll("input:not(:disabled)").forEach((node) => { node.checked = $("import-all").checked; }); updateImportSelection(); });
  $("confirm-import").addEventListener("click", () => void importConnections());
  document.addEventListener("pointerdown", (event) => { if (!$("connection-menu").contains(event.target) && !menuTrigger?.contains(event.target)) hideMenu(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("connection-menu").hidden) { event.preventDefault(); hideMenu(true); } });
  addEventListener("resize", () => hideMenu());
  addEventListener("scroll", () => hideMenu(), true);
  $("reopen").addEventListener("click", () => {
    if (serviceFailure?.action === "retry") { void refresh(true); return; }
    const url = launcherURL(location.hash);
    if (url) { location.replace(url); return; }
    location.reload();
  });
  render(); void refresh();
  const polling = setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
  const clock = setInterval(updateDuration, 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
  addEventListener("pagehide", () => { clearInterval(polling); clearInterval(clock); remote.close(); $("login-password").value = $("login-passphrase").value = ""; }, { once: true });
})();
