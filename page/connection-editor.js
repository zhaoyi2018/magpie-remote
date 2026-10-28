(() => {
  window.createSSHConnectionEditor = ({ getRows, isOnline, call, onSaved }) => {
  const $ = (id) => document.getElementById(id);
  let editingConnection = null;
  let editingRevision = null, editingForwards = [];
  let hasSavedPassword = false;
  let connectionSaving = false;
  const uniqueId = (prefix) => prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  for (const node of document.querySelectorAll("#connection-editor [data-icon]")) {
    if (node.children.length) continue;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", node.dataset.icon === "close" ? "M6 6l12 12M6 18 18 6" : "m6 9 6 6 6-6");
    svg.append(path); node.append(svg);
  }
  function authFields() {
    const mode = $("profile-auth").value;
    for (const option of document.querySelectorAll("[data-auth]")) {
      option.setAttribute("aria-checked", String(option.dataset.auth === mode));
      option.tabIndex = option.dataset.auth === mode ? 0 : -1;
    }
    $("agent-fields").hidden = mode !== "agent";
    $("profile-password-row").hidden = mode !== "password";
    $("profile-password").required = mode === "password" && !hasSavedPassword;
    if (mode !== "password") $("profile-password").value = "";
    $("profile-identity").required = mode === "key";
    $("profile-identity-label").textContent = mode === "key" ? "私钥路径" : "私钥路径（可选）";
    $("profile-auth-hint").textContent = mode === "password" ? (hasSavedPassword ? "密码已加密保存，留空保留；填写新密码可替换" : "密码加密保存在本机，下次连接时自动使用")
      : mode === "agent" ? "优先使用当前系统的 SSH agent 身份凭证"
      : mode === "key" ? "使用本机私钥文件认证，无需上传私钥"
      : "从应用启动环境读取密码；留空可在连接时输入密码";
    if (["key", "environment"].includes(mode)) $("profile-auth-advanced").open = true;
    if (mode === "password") $("profile-auth-advanced").open = false;
  }
  function openConnection(connection) {
    if (connectionSaving) return;
    const row = connection && getRows().find((item) => item.connection.id === connection.id);
    connection = row?.connection ?? connection;
    editingConnection = connection?.id ?? null;
    editingRevision = row?.revision ?? null;
    hasSavedPassword = row?.hasSavedPassword === true;
    editingForwards = structuredClone(connection?.forwards ?? []);
    $("connection-form").reset();
    $("profile-password").value = "";
    $("profile-password").placeholder = hasSavedPassword ? "留空保留已保存密码" : "输入服务器登录密码";
    $("connection-editor-title").textContent = connection ? "编辑 SSH 连接" : "新建 SSH 连接";
    $("connection-editor-description").textContent = connection ? "更新连接配置，下次连接时生效" : "保存连接配置，认证成功后建立独立会话";
    $("save-connection").textContent = connection ? "保存修改" : "保存并连接";
    const fields = { name: "name", host: "host", port: "port", username: "username", identity: "identityFile", agent: "agent", "password-env": "passwordEnv", "passphrase-env": "passphraseEnv", fingerprint: "hostFingerprint", "known-hosts": "knownHostsFile", id: "id" };
    for (const [field, key] of Object.entries(fields)) $("profile-" + field).value = connection?.[key] ?? (field === "port" ? 22 : "");
    $("profile-id").readOnly = Boolean(connection);
    $("profile-auth").value = connection?.authMethod ?? (!connection ? "agent" : connection.identityFile ? "key" : connection.agent ? "agent" : "environment");
    $("profile-auto-forwards").checked = connection?.autoStartForwards !== false;
    $("profile-continue-forwards").checked = connection?.forwardFailurePolicy === "continue";
    $("profile-auto-connect").checked = connection?.autoConnect === true;
    $("profile-auto-reconnect").checked = connection?.autoReconnect === true;
    $("profile-error").hidden = true;
    $("profile-auth-advanced").open = true;
    $("profile-host-advanced").open = false;
    authFields(); $("connection-editor").showModal();
    $("connection-editor").querySelector(".dialog-content").scrollTop = 0;
  }
  function validateInputs(ids) {
    for (const id of ids) {
      if (!$(id).checkValidity()) {
        const details = $(id).closest("details"); if (details) details.open = true;
        $(id).reportValidity(); throw new Error("请检查必填字段和端口范围");
      }
    }
  }
  async function saveConnection(event) {
    event.preventDefault();
    if (connectionSaving) return;
    connectionSaving = true;
    const isNew = !editingConnection;
    $("save-connection").disabled = true; $("profile-error").hidden = true;
    $("save-connection").textContent = "正在保存…";
    $("connection-editor").querySelectorAll(".close-dialog").forEach((node) => { node.disabled = true; });
    try {
      if (!isOnline()) throw new Error("管理服务已离线，请重新打开页面");
      if (!isNew && !editingRevision) throw new Error("连接已不存在或配置版本不可用，请关闭弹窗后重新读取配置");
      validateInputs(["profile-name", "profile-host", "profile-port", "profile-username", "profile-id", "profile-identity", "profile-passphrase-env", "profile-password-env", "profile-password"]);
      const connection = { id: $("profile-id").value.trim() || uniqueId("server"), name: $("profile-name").value.trim(), host: $("profile-host").value.trim(), port: Number($("profile-port").value), username: $("profile-username").value.trim(), forwards: editingForwards };
      connection.authMethod = $("profile-auth").value;
      connection.autoStartForwards = $("profile-auto-forwards").checked;
      if ($("profile-continue-forwards").checked) connection.forwardFailurePolicy = "continue";
      connection.autoConnect = $("profile-auto-connect").checked;
      connection.autoReconnect = $("profile-auto-reconnect").checked;
      if (!editingConnection && getRows().some((row) => row.connection.id === connection.id)) throw new Error("连接标识已存在，请使用其他标识");
      const mode = $("profile-auth").value;
      const optional = { hostFingerprint: "profile-fingerprint", knownHostsFile: "profile-known-hosts", identityFile: "profile-identity", passphraseEnv: "profile-passphrase-env", passwordEnv: "profile-password-env" };
      if (mode === "key") {
        if (!$("profile-identity").value.trim()) throw new Error("请填写私钥文件路径");
      } else if (mode === "agent") {
        optional.agent = "profile-agent";
      }
      for (const [key, id] of Object.entries(optional)) if ($(id).value.trim()) connection[key] = $(id).value.trim();
      const password = mode === "password" ? $("profile-password").value : "";
      const saved = await call("save_connection", { connection, expectedRevision: editingRevision }, password ? { password } : undefined);
      $("profile-password").value = "";
      $("connection-editor").close();
      await onSaved(saved.connection, isNew);
    } catch (error) {
      $("profile-error").textContent = error.message;
      $("profile-error").hidden = false;
      $("profile-error").scrollIntoView({ block: "nearest" });
    }
    finally {
      connectionSaving = false;
      $("save-connection").disabled = !isOnline();
      $("save-connection").textContent = isNew ? "保存并连接" : "保存修改";
      $("connection-editor").querySelectorAll(".close-dialog").forEach((node) => { node.disabled = false; });
    }
  }

  const form = $("connection-form"), action = $("save-connection");
  form.noValidate = true;
  form.addEventListener("submit", saveConnection);
  // CSP sandbox blocks native form submission before a submit event is emitted.
  action.addEventListener("click", saveConnection);
  form.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || !event.target.matches('input:not([type="checkbox"])')) return;
    event.preventDefault();
    if (!action.disabled) action.click();
  });
  $("profile-auth").addEventListener("change", authFields);
  document.querySelectorAll("[data-auth]").forEach((option, index, options) => {
    const choose = (next) => { $("profile-auth").value = next.dataset.auth; authFields(); next.focus(); };
    option.addEventListener("click", () => choose(option));
    option.addEventListener("keydown", (event) => {
      let next = index;
      if (["ArrowRight", "ArrowDown"].includes(event.key)) next = (index + 1) % options.length;
      else if (["ArrowLeft", "ArrowUp"].includes(event.key)) next = (index + options.length - 1) % options.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = options.length - 1;
      else return;
      event.preventDefault(); choose(options[next]);
    });
  });
  $("connection-editor").addEventListener("cancel", (event) => { if (connectionSaving) event.preventDefault(); });
  $("connection-editor").addEventListener("close", () => { if (!$("connection-editor").open) $("profile-password").value = ""; });
  addEventListener("pagehide", () => { $("profile-password").value = ""; });

  function sync() { $("save-connection").disabled = connectionSaving || !isOnline(); }
  return { open: openConnection, sync };
  };
})();
