import { OperationError } from "./errors.mjs";
import { shellQuote } from "./remote-scripts.mjs";

const quoted = (value) => '"' + String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';

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
  const response = await sessions.execute(id, "sh -s", { input: remoteHTTPScript(url, options), signal: options.signal, timeoutMs: 7000, maxBytes: options.maxBytes ?? 262144 });
  if (response.code !== 0) throw new OperationError("PROVIDER_LINK_HTTP", "远端无法直接访问 HTTP 服务或鉴权失败");
  let text = response.stdout;
  let status, headers;
  // Skip informational HTTP responses without mixing their headers into the body.
  do {
    const match = /^HTTP\/\d(?:\.\d)? (\d{3})[^\r\n]*\r?\n((?:[^\r\n]+\r?\n)*)\r?\n/.exec(text);
    if (!match) throw new OperationError("PROVIDER_LINK_HTTP", "远端 HTTP 响应无效");
    status = Number(match[1]); headers = match[2]; text = text.slice(match[0].length);
  } while (status >= 100 && status < 200);
  return { status, headers, body: text };
}

export async function remoteProviderAPI(sessions, id, link, { signal } = {}) {
  const url = new URL(link.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || !url.port || url.username || url.password || url.hash
    || !/^[A-Za-z0-9._~-]{16,256}$/.test(url.searchParams.get("k") ?? "")) throw new OperationError("PROVIDER_LINK_AUTH", "远端管理链接无效");
  const signedIn = await remoteHTTP(sessions, id, url.href, { signal, maxBytes: 16384 });
  const cookie = signedIn.headers.split(/\r?\n/).filter((line) => /^set-cookie:/i.test(line)).map((line) => line.slice(line.indexOf(":") + 1).trim().split(";")[0]).find((value) => /^[A-Za-z0-9_-]{1,128}=[A-Za-z0-9._~-]{16,256}$/.test(value));
  if (signedIn.status !== 303 || !cookie) throw new OperationError("PROVIDER_LINK_AUTH", "无法通过 SSH 登录远端 Magpie 管理接口");
  return async (path, body) => {
    if (!(path === "/api/providers" && body === undefined || path === "/api/provider/save" && body)) throw new Error("未知的供应商管理操作");
    const response = await remoteHTTP(sessions, id, new URL(path, url.origin).href, { signal, headers: { Cookie: cookie }, ...(body && { method: "POST", body }), maxBytes: 16 * 1024 * 1024 });
    if (response.status < 200 || response.status >= 300) throw new OperationError("PROVIDER_LINK_API", "远端供应商接口返回错误");
    try { return JSON.parse(response.body); }
    catch { throw new OperationError("PROVIDER_LINK_API", "远端供应商接口未返回有效 JSON"); }
  };
}
