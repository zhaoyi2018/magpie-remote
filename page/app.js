(() => {
  const $ = (id) => document.getElementById(id);
  const state = { rows: [], selected: null, online: false, tab: "forwards", busy: new Map(), errors: new Map(), cancelled: new Set() };
  const base = new URL("./", location.href);
  const token = base.pathname.split("/")[1];
  let refreshing = false;
  let editingConnection = null;
  let editingForwardConnection = null;
  let toastTimer;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(label, action, className = "button small", disabled = false) {
    const node = element("button", className, label);
    node.type = "button";
    node.disabled = disabled;
    node.addEventListener("click", action);
    return node;
  }
  function toast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 2700);
  }
  function selected() { return state.rows.find((row) => row.connection.id === state.selected); }
  function active(session) { return ["connected", "connecting"].includes(session.state); }
  function endpoint(host, port) { return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`; }
  const labels = { connecting: "正在连接", connected: "已连接", disconnected: "未连接", failed: "连接失败", listening: "运行中", starting: "启动中", stopping: "停止中", stopped: "未启动" };

  async function request(path, options = {}, timeout = 50000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(new URL(path, base), {
        ...options, credentials: "omit", signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, ...options.headers },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("请求超时，请检查连接状态后重试");
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function call(method, args = {}, credentials) {
    return (await request("api/call", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, args, ...(credentials && { credentials }) }),
    })).result;
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const snapshot = await request("api/snapshot", {}, 5000);
      state.rows = snapshot.connections;
      state.online = true;
      if (!selected()) state.selected = state.rows[0]?.connection.id ?? null;
      $("last-updated").textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN")}`;
      $("service-state").textContent = "● 管理服务在线";
      $("service-error").hidden = true;
    } catch {
      state.online = false;
      $("service-error").hidden = false;
      $("service-state").textContent = "管理服务离线";
      $("last-updated").textContent = "当前显示最后读取的状态";
    } finally { refreshing = false; render(); }
  }

  async function run(id, name, operation, message) {
    const owner = Symbol();
    state.busy.set(id, { owner, name });
    state.errors.delete(id);
    render();
    try {
      await operation();
      if (message) toast(message);
    } catch (error) {
      if (!(name === "connect" && state.cancelled.has(id))) state.errors.set(id, error.message);
    } finally {
      if (state.busy.get(id)?.owner === owner) state.busy.delete(id);
      await refresh();
      render();
    }
  }

  function render() {
    const query = $("search").value.trim().toLowerCase();
    $("connection-count").textContent = state.rows.length;
    $("connection-list").replaceChildren();
    for (const row of state.rows.filter(({ connection }) => `${connection.name} ${connection.host} ${connection.username}`.toLowerCase().includes(query))) {
      const { connection, session } = row;
      const card = button("", () => {
        state.selected = connection.id;
        $("login-password").value = "";
        $("login-passphrase").value = "";
        setTab("forwards");
        render();
      }, "connection-card");
      card.setAttribute("aria-current", String(connection.id === state.selected));
      card.setAttribute("aria-label", `${connection.name}，${labels[session.state] ?? session.state}`);
      const title = element("div", "card-title");
      const dot = element("span", `state-dot ${session.state}`);
      dot.title = labels[session.state] ?? session.state;
      title.append(element("span", "", connection.name), dot);
      card.append(title, element("div", "card-address mono", `${connection.username}@${connection.host}`));
      $("connection-list").append(card);
    }
    if (!$("connection-list").children.length) $("connection-list").append(element("p", "no-matches", query ? "没有匹配的服务器" : "尚未添加服务器"));
    const connected = state.rows.filter((row) => row.session.state === "connected").length;
    const forwards = state.rows.reduce((sum, row) => sum + row.session.forwards.filter((rule) => rule.state === "listening").length, 0);
    $("summary").textContent = connected ? `${connected} 台已连接 · ${forwards} 条转发运行中` : "尚未连接服务器";
    const row = selected();
    $("empty-state").hidden = Boolean(row);
    $("connection-detail").hidden = !row;
    if (!row) return;
    const { connection, session } = row;
    const busy = state.busy.get(connection.id);
    const sessionState = busy?.name === "connect" && session.state !== "connected" ? "connecting" : session.state;
    $("detail-name").textContent = connection.name;
    $("detail-address").textContent = `${connection.username}@${endpoint(connection.host, connection.port)}`;
    $("detail-state").className = `badge ${sessionState}`;
    $("detail-state").textContent = labels[sessionState] ?? sessionState;
    $("connect").textContent = sessionState === "connecting" ? "正在连接…" : "连接服务器";
    $("connect").disabled = !state.online || active({ state: sessionState }) || Boolean(busy);
    $("disconnect").disabled = !state.online || !active({ state: sessionState });
    $("disconnect").textContent = sessionState === "connecting" ? "取消连接" : "断开连接";
    $("credentials").hidden = active({ state: sessionState });
    if (!connection.identityFile && !connection.agent && !connection.passwordEnv && !active({ state: sessionState })) $("credentials").open = true;
    $("connection-time").textContent = session.state === "connected" && session.connectedAt ? `连接于 ${new Date(session.connectedAt).toLocaleTimeString("zh-CN")}` : "";
    const error = state.errors.get(connection.id) ?? (session.state === "failed" ? session.lastError : "");
    $("operation-error").textContent = error ?? "";
    $("operation-error").hidden = !error;
    $("new-forward").disabled = $("empty-forward").disabled = !state.online || Boolean(busy);
    $("edit-connection").disabled = $("delete-connection").disabled = active(session) || Boolean(busy) || !state.online;
    renderForwards(row, Boolean(busy));
    renderSettings(row);
  }

  function renderForwards({ connection, session }, busy) {
    const rules = new Map(connection.forwards.map((rule) => [rule.id, { ...rule, saved: true, state: "stopped" }]));
    for (const live of session.forwards) rules.set(live.id, { ...rules.get(live.id), ...live });
    $("forward-list").replaceChildren();
    $("forward-count").textContent = rules.size;
    $("forward-empty").hidden = rules.size > 0;
    $("forward-list").closest(".table-wrap").hidden = rules.size === 0;
    for (const rule of rules.values()) {
      const tr = element("tr");
      const name = element("td", "rule-direction");
      name.append(element("div", "rule-name", rule.id), element("span", `direction-tag ${rule.direction === "s2c" ? "blue" : ""}`, `${rule.direction} / ${rule.direction === "c2s" ? "-L" : "-R"}`));
      const binding = element("td", "endpoint mono", endpoint(rule.bindHost, rule.bindPort));
      binding.append(element("small", "", rule.direction === "c2s" ? "客户端监听" : "服务器监听"));
      const target = element("td", "endpoint mono", endpoint(rule.targetHost, rule.targetPort));
      target.append(element("small", "", rule.direction === "c2s" ? "服务器目标" : "客户端目标"));
      const status = element("td");
      status.append(element("span", `badge ${rule.state}`, labels[rule.state] ?? rule.state));
      if (!rule.saved) status.append(element("div", "muted", "临时"));
      if (rule.lastError) status.append(element("div", "row-error", rule.lastError));
      const actions = element("td");
      const actionsBox = element("div", "rule-actions");
      const running = session.forwards.some((item) => item.id === rule.id);
      const enabled = state.online && !busy;
      if (running) actionsBox.append(button("停止", () => run(connection.id, "stop-forward", () => call("forward_remove", { connectionId: connection.id, forwardId: rule.id }), "转发已停止"), "button small", !enabled));
      else actionsBox.append(button("启动", () => run(connection.id, "start-forward", () => call("forward_add", { connectionId: connection.id, forward: connection.forwards.find((item) => item.id === rule.id) }), "转发已启动"), "button small", !enabled || session.state !== "connected"));
      const edit = button("编辑", () => openForward(rule), "button small", !enabled || running || !rule.saved);
      edit.title = running ? "先停止这条转发再编辑" : "编辑预设";
      const remove = button("删除", async () => {
        if (await confirmAction("删除转发规则", `删除「${rule.id}」的预设；正在运行的转发也会停止。`)) {
          await run(connection.id, "delete-forward", () => call("forward_delete", { connectionId: connection.id, forwardId: rule.id }), "转发规则已删除");
        }
      }, "button small danger", !enabled);
      actionsBox.append(edit, remove);
      actions.append(actionsBox);
      tr.append(name, binding, element("td", "arrow-cell", "→"), target, status, actions);
      $("forward-list").append(tr);
    }
  }

  function renderSettings({ connection, session }) {
    const authentication = connection.identityFile ? "私钥文件" : connection.agent ? "SSH Agent" : connection.passwordEnv ? "密码环境变量" : "每次输入密码 / 宿主 SSH Agent";
    const values = [
      ["连接标识", connection.id], ["服务器地址", endpoint(connection.host, connection.port)], ["用户名", connection.username],
      ["登录方式", authentication], ["私钥路径", connection.identityFile], ["Agent 地址", connection.agent],
      ["密码环境变量", connection.passwordEnv], ["私钥口令变量", connection.passphraseEnv],
      ["主机指纹", connection.hostFingerprint ?? session.hostFingerprint ?? "使用 known_hosts 校验"],
      ["known_hosts", connection.knownHostsFile ?? "~/.ssh/known_hosts"],
    ];
    $("settings-list").replaceChildren();
    for (const [label, value] of values) {
      if (!value) continue;
      const row = element("div", "settings-row");
      row.append(element("dt", "", label), element("dd", "mono", value));
      $("settings-list").append(row);
    }
  }

  function setTab(tab) {
    state.tab = tab;
    for (const name of ["forwards", "settings"]) {
      $("tab-" + name).setAttribute("aria-selected", String(tab === name));
      $("panel-" + name).hidden = tab !== name;
    }
  }
  function authFields() {
    const mode = $("profile-auth").value;
    for (const name of ["key", "agent", "password", "environment"]) $(name + "-fields").hidden = mode !== name;
  }
  function openConnection(connection) {
    editingConnection = connection?.id ?? null;
    $("connection-editor-title").textContent = connection ? "编辑 SSH 连接" : "新增 SSH 连接";
    const fields = { name: "name", host: "host", port: "port", username: "username", identity: "identityFile", agent: "agent", "password-env": "passwordEnv", "passphrase-env": "passphraseEnv", fingerprint: "hostFingerprint", "known-hosts": "knownHostsFile", id: "id" };
    for (const [field, key] of Object.entries(fields)) $("profile-" + field).value = connection?.[key] ?? (field === "port" ? 22 : field === "identity" && !connection ? "~/.ssh/id_ed25519" : "");
    $("profile-id").readOnly = Boolean(connection);
    $("profile-auth").value = !connection || connection.identityFile ? "key" : connection.agent ? "agent" : connection.passwordEnv ? "environment" : "password";
    $("profile-error").hidden = true;
    authFields();
    $("connection-editor").showModal();
  }
  function validateInputs(ids) {
    for (const id of ids) {
      if (!$(id).checkValidity()) { $(id).reportValidity(); throw new Error("请检查必填字段和端口范围"); }
    }
  }
  async function saveConnection() {
    const save = $("save-connection");
    save.disabled = true;
    $("profile-error").hidden = true;
    try {
      validateInputs(["profile-name", "profile-host", "profile-port", "profile-username", "profile-id"]);
      const connection = {
        id: $("profile-id").value.trim() || `server-${Date.now().toString(36)}`,
        name: $("profile-name").value.trim(), host: $("profile-host").value.trim(),
        port: Number($("profile-port").value), username: $("profile-username").value.trim(),
        forwards: state.rows.find((row) => row.connection.id === editingConnection)?.connection.forwards ?? [],
      };
      const mode = $("profile-auth").value;
      const optional = { hostFingerprint: "profile-fingerprint", knownHostsFile: "profile-known-hosts" };
      if (mode === "key") {
        if (!$("profile-identity").value.trim()) throw new Error("请填写私钥文件路径");
        optional.identityFile = "profile-identity";
        optional.passphraseEnv = "profile-passphrase-env";
      } else if (mode === "agent") {
        if (!$("profile-agent").value.trim()) throw new Error("请填写 SSH Agent 地址");
        optional.agent = "profile-agent";
      } else if (mode === "environment") {
        if (!$("profile-password-env").value.trim()) throw new Error("请填写密码环境变量名称");
        optional.passwordEnv = "profile-password-env";
      }
      for (const [key, id] of Object.entries(optional)) if ($(id).value.trim()) connection[key] = $(id).value.trim();
      await call("save_connection", { connection });
      state.selected = connection.id;
      $("connection-editor").close();
      setTab("forwards");
      toast("连接配置已保存");
      await refresh();
    } catch (error) {
      $("profile-error").textContent = error.message;
      $("profile-error").hidden = false;
    } finally { save.disabled = false; }
  }

  function rulePreview() {
    const c2s = $("rule-direction").value === "c2s";
    $("bind-host-label").textContent = c2s ? "本地监听地址" : "服务器监听地址";
    $("target-host-label").textContent = c2s ? "服务器目标地址" : "本地目标地址";
    $("rule-preview").textContent = c2s ? "本地监听  →  SSH 加密连接  →  服务器上的服务" : "服务器监听  →  SSH 加密连接  →  本地服务";
  }
  function openForward(rule) {
    editingForwardConnection = state.selected;
    $("forward-editor-title").textContent = rule ? "编辑端口转发" : "添加端口转发";
    const values = { id: rule?.id ?? "", direction: rule?.direction ?? "c2s", "bind-host": rule?.bindHost ?? "127.0.0.1", "bind-port": rule?.bindPort ?? "", "target-host": rule?.targetHost ?? "127.0.0.1", "target-port": rule?.targetPort ?? "" };
    for (const [name, value] of Object.entries(values)) $("rule-" + name).value = value;
    $("rule-id").readOnly = Boolean(rule);
    $("rule-error").hidden = true;
    rulePreview();
    $("forward-editor").showModal();
  }
  async function saveForward() {
    $("save-forward").disabled = true;
    $("rule-error").hidden = true;
    try {
      validateInputs(["rule-id", "rule-bind-host", "rule-bind-port", "rule-target-host", "rule-target-port"]);
      const forward = {
        id: $("rule-id").value.trim(), direction: $("rule-direction").value,
        bindHost: $("rule-bind-host").value.trim(), bindPort: Number($("rule-bind-port").value),
        targetHost: $("rule-target-host").value.trim(), targetPort: Number($("rule-target-port").value),
      };
      await call("forward_save", { connectionId: editingForwardConnection, forward });
      $("forward-editor").close();
      toast("转发规则已保存，连接后即可启动");
      await refresh();
    } catch (error) {
      $("rule-error").textContent = error.message;
      $("rule-error").hidden = false;
    } finally { $("save-forward").disabled = false; }
  }

  function confirmAction(title, description) {
    $("confirm-title").textContent = title;
    $("confirm-description").textContent = description;
    const dialog = $("confirm-dialog");
    dialog.returnValue = "";
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true });
      dialog.showModal();
    });
  }
  $("confirm-cancel").addEventListener("click", () => $("confirm-dialog").close("cancel"));
  $("confirm-accept").addEventListener("click", () => $("confirm-dialog").close("yes"));
  document.querySelectorAll(".close-dialog").forEach((node) => node.addEventListener("click", () => node.closest("dialog").close()));
  for (const id of ["new-connection", "empty-add"]) $(id).addEventListener("click", () => openConnection());
  for (const id of ["new-forward", "empty-forward"]) $(id).addEventListener("click", () => openForward());
  $("edit-connection").addEventListener("click", () => openConnection(selected().connection));
  $("save-connection").addEventListener("click", saveConnection);
  $("save-forward").addEventListener("click", saveForward);
  $("profile-auth").addEventListener("change", authFields);
  $("rule-direction").addEventListener("change", rulePreview);
  $("search").addEventListener("input", render);
  $("refresh").addEventListener("click", refresh);
  $("tab-forwards").addEventListener("click", () => setTab("forwards"));
  $("tab-settings").addEventListener("click", () => setTab("settings"));
  $("connect").addEventListener("click", () => {
    const row = selected();
    if (!row) return;
    const id = row.connection.id;
    const credentials = { password: $("login-password").value, passphrase: $("login-passphrase").value };
    $("login-password").value = "";
    $("login-passphrase").value = "";
    state.cancelled.delete(id);
    void run(id, "connect", () => call("connect", { connectionId: id }, credentials), "SSH 连接成功");
  });
  $("disconnect").addEventListener("click", () => {
    const id = state.selected;
    state.cancelled.add(id);
    void run(id, "disconnect", () => call("disconnect", { connectionId: id }), "SSH 连接已断开");
  });
  $("delete-connection").addEventListener("click", async () => {
    const row = selected();
    if (row && await confirmAction("删除 SSH 连接", `删除「${row.connection.name}」及其全部转发预设。`)) {
      await run(row.connection.id, "delete", () => call("remove_connection", { connectionId: row.connection.id }), "连接已删除");
    }
  });
  $("reopen").addEventListener("click", () => {
    try {
      const url = new URL(new URLSearchParams(location.hash.slice(1)).get("launcher"));
      if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.pathname.startsWith("/_magpie/plugin/")) {
        location.replace(url.href);
        return;
      }
    } catch { /* A standalone preview has no launcher. */ }
    location.reload();
  });
  void refresh();
  const polling = setInterval(refresh, 2000);
  addEventListener("pagehide", () => clearInterval(polling), { once: true });
})();
