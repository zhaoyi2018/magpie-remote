export function launcherURL(hash) {
  try {
    const url = new URL(new URLSearchParams(hash.replace(/^#/, "")).get("launcher"));
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    const desktop = url.origin === "http://wails.localhost";
    if (url.protocol === "http:" && (local || desktop) && !url.username && !url.password
      && url.pathname.startsWith("/_magpie/plugin/")) return url.href;
  } catch { /* Standalone pages do not have a launcher. */ }
  return null;
}

export async function readResponse(response) {
  let data;
  try { data = await response.json(); }
  catch {
    throw Object.assign(new Error("管理服务返回了无法读取的响应，请重试"), { code: "INVALID_RESPONSE", status: response.status });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("管理服务返回了无法读取的响应，请重试"), { code: "INVALID_RESPONSE", status: response.status });
  }
  if (!response.ok) throw Object.assign(new Error(data.error || "请求失败 (" + response.status + ")"), {
    code: data.code ?? ([401, 404].includes(response.status) ? "MANAGEMENT_EXPIRED" : "OPERATION_FAILED"),
    status: response.status,
    category: data.category, retryable: data.retryable === true,
    ...(data.code === "CREDENTIALS_REQUIRED" && { credentialFields: data.credentialFields }),
  });
  return data;
}

export function connectionGuidance(error, connection = {}) {
  if (!error) return "";
  if (error.category === "trust" || error.code?.startsWith("HOST_KEY_")) {
    return error.code === "HOST_KEY_UNAVAILABLE" ? "在「连接设置 → 编辑配置 → 主机校验与其他设置」检查 known_hosts 路径与读取权限。"
      : "通过服务器控制台或管理员独立核对 SHA256 主机指纹，再在「编辑配置 → 主机校验与其他设置」填写。若公钥变化，先核实原因，再更新 known_hosts；不要直接信任报错中收到的公钥。";
  }
  if (["KEY_UNAVAILABLE", "KEY_INVALID"].includes(error.code)) return "在「编辑配置 → 高级认证设置」检查私钥路径、读取权限和文件格式；应选择私钥文件。加密私钥可通过「填写凭据并连接」提供本次口令。";
  if (error.category === "credentials" || error.code === "CREDENTIALS_REQUIRED") return "可在「连接设置 → 填写凭据并连接」输入本次密码或私钥口令。环境变量需要由运行 Magpie 的进程继承，设置后请重新加载宿主。";
  if (error.category === "authentication" || error.code === "SSH_AUTH_FAILED") {
    return connection.authMethod === "agent" || connection.agent
      ? "核对服务器用户名，并在运行 Magpie 的同一账户下执行 ssh-add -l 检查 agent 是否有可用身份；Windows 检查 OpenSSH Authentication Agent 服务与命名管道，其他系统检查 SSH_AUTH_SOCK。也可在「编辑配置」改用私钥或密码。"
      : "核对服务器用户名、密码或已授权的公钥；加密私钥需要正确口令。可先使用同一账户、主机与端口验证系统 SSH 登录，再回到「编辑配置」检查认证方式。";
  }
  if (error.category === "network" || ["SSH_TIMEOUT", "SSH_NETWORK", "SSH_DISCONNECTED"].includes(error.code)) return "检查主机地址、SSH 端口、VPN 和防火墙，并确认服务器 sshd 可访问。网络恢复后手动连接；已启用自动重连时可查看重连状态或停止重试。";
  return "";
}

export function managementFailure(error) {
  if (error.code === "CONFIG_INVALID" || error.code === "CONFIG_UNREADABLE") {
    return { label: "连接配置需要修复", message: error.message + "。管理服务仍在运行，可从「备份与恢复」恢复，或修复配置文件后重试。", action: "retry" };
  }
  if (error.code === "MANAGEMENT_EXPIRED") {
    return { label: "管理页面已过期", message: "插件可能已重新加载，请重新打开页面以获取新的管理地址。", action: "reopen" };
  }
  if (error.code === "SERVICE_UNREACHABLE") {
    return { label: "管理服务离线", message: "暂时无法连接管理服务，当前显示最后读取的状态。请重新打开页面；仍不可用时重新加载插件。", action: "reopen" };
  }
  return { label: error.code === "REQUEST_TIMEOUT" ? "管理服务响应超时" : "读取状态失败", message: error.message + "。当前显示最后读取的状态，请重试。", action: "retry" };
}
