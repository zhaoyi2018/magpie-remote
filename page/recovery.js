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
