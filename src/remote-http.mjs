import { OperationError } from "./errors.mjs";
import { shellQuote } from "./remote-scripts.mjs";

const quoted = (value) => '"' + String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';

function requestLabel(url, context) {
  const address = new URL(url);
  // Never publish login query strings, cookies, response bodies or curl stderr.
  return (context ?? "远端 HTTP 请求") + "（" + address.origin + address.pathname + "）";
}

function httpFailure(label, status) {
  const reason = [401, 403].includes(status) ? "认证或访问权限被拒绝，请核对该服务的密钥和登录会话"
    : status === 404 ? "接口不存在，请检查远端 Magpie 的服务端口与版本"
    : status >= 500 ? "服务端处理失败，请检查远端 Magpie 服务状态" : "请求被服务拒绝";
  return new OperationError("PROVIDER_LINK_HTTP", label + `：HTTP ${status}，` + reason);
}

function transportFailure(label, code) {
  const reason = {
    2: "远端 curl 不支持请求参数或配置格式", 3: "远端 curl 无法解析请求地址",
    5: "远端无法解析代理地址", 6: "远端无法解析目标地址", 7: "无法连接目标端口，请检查服务监听和网络访问",
    22: "HTTP 服务拒绝请求，未取得有效状态码", 23: "远端响应写入失败",
    28: "请求超时，请检查网络、防火墙及服务响应", 52: "目标服务未返回 HTTP 响应",
    56: "读取 HTTP 响应时连接中断", 69: "远端缺少 curl", 127: "远端无法执行 curl",
  }[code] ?? "远端 curl 请求未成功完成";
  return new OperationError("PROVIDER_LINK_HTTP", label + `：${reason}（curl 退出码 ${Number.isInteger(code) ? code : "未知"}）`);
}

function parseHTTP(text) {
  let status, headers;
  // Skip informational HTTP responses without mixing their headers into the body.
  do {
    const match = /^HTTP\/\d(?:\.\d)? (\d{3})[^\r\n]*\r?\n((?:[^\r\n]+\r?\n)*)\r?\n/.exec(text);
    if (!match) throw new Error("Invalid HTTP response");
    status = Number(match[1]); headers = match[2]; text = text.slice(match[0].length);
  } while (status >= 100 && status < 200);
  return { status, headers, body: text };
}

// Configuration, including credentials, travels in SSH stdin rather than argv.
// curl -q ignores per-user curlrc; proxy and redirect settings are fixed here.
export function remoteHTTPScript(url, { method = "GET", headers = {}, body } = {}) {
  const address = new URL(url);
  if (address.protocol !== "http:" || address.username || address.password || address.hash || /[\x00-\x1f\x7f]/.test(url)
    || !["GET", "POST"].includes(method)) throw new Error("远端 HTTP 请求无效");
  const options = ["silent", "show-error", "fail", "connect-timeout = 2", "max-time = 5", 'noproxy = "*"', 'proxy = ""', 'proto = "=http"', "max-redirs = 0", 'dump-header = "-"', "url = " + quoted(address.href), "request = " + quoted(method)];
  for (const [key, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]+$/.test(key) || typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) throw new Error("远端 HTTP 请求头无效");
    options.push("header = " + quoted(key + ": " + value));
  }
  if (body !== undefined) options.push("header = " + quoted("Content-Type: application/json"), "data = " + quoted(JSON.stringify(body)));
  return "# MIGPIE_HTTP_V1\nset -eu\ncommand -v curl >/dev/null || exit 69\nprintf '%s\\n' " + options.map(shellQuote).join(" ") + " | curl -q --config - 2>/dev/null\n";
}

export async function remoteHTTP(sessions, id, url, options = {}) {
  const label = requestLabel(url, options.context);
  const response = await sessions.execute(id, "sh -s", { input: remoteHTTPScript(url, options), signal: options.signal, timeoutMs: 7000, maxBytes: options.maxBytes ?? 262144 });
  if (![0, 22].includes(response.code)) throw transportFailure(label, response.code);
  let result;
  try { result = parseHTTP(response.stdout); }
  catch { throw response.code === 22 ? transportFailure(label, 22) : new OperationError("PROVIDER_LINK_HTTP", label + "：未返回有效的 HTTP 响应，请检查目标端口与服务协议"); }
  if (result.status >= 400) throw httpFailure(label, result.status);
  if (response.code !== 0) throw transportFailure(label, response.code);
  return result;
}

export async function remoteProviderAPI(sessions, id, link, { signal } = {}) {
  const url = new URL(link.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || !url.port || url.username || url.password || url.hash
    || !/^[A-Za-z0-9._~-]{16,256}$/.test(url.searchParams.get("k") ?? "")) throw new OperationError("PROVIDER_LINK_AUTH", "远端管理链接无效");
  const signedIn = await remoteHTTP(sessions, id, url.href, { signal, maxBytes: 16384, context: "登录远端 Web 管理服务" });
  const cookie = signedIn.headers.split(/\r?\n/).filter((line) => /^set-cookie:/i.test(line)).map((line) => line.slice(line.indexOf(":") + 1).trim().split(";")[0]).find((value) => /^[A-Za-z0-9_-]{1,128}=[A-Za-z0-9._~-]{16,256}$/.test(value));
  if (signedIn.status !== 303 || !cookie) throw new OperationError("PROVIDER_LINK_AUTH", requestLabel(url.href, "登录远端 Web 管理服务") + `：HTTP ${signedIn.status}，未取得有效登录会话，请核对 Web 管理密钥和服务版本`);
  return async (path, body) => {
    if (!(path === "/api/providers" && body === undefined || path === "/api/provider/save" && body)) throw new Error("未知的供应商管理操作");
    const target = new URL(path, url.origin).href, context = body ? "保存远端供应商" : "读取远端供应商列表";
    const response = await remoteHTTP(sessions, id, target, { signal, context, headers: { Accept: "application/json", Cookie: cookie }, ...(body && { method: "POST", body }), maxBytes: 16 * 1024 * 1024 });
    if (response.status < 200 || response.status >= 300) throw new OperationError("PROVIDER_LINK_API", requestLabel(target, context) + `：HTTP ${response.status}，未取得预期的成功响应`);
    try { return JSON.parse(response.body); }
    catch { throw new OperationError("PROVIDER_LINK_API", requestLabel(target, context) + "：未返回有效 JSON，请检查服务端口与版本"); }
  };
}
