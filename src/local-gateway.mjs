import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Agent, createServer, request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { OperationError } from "./errors.mjs";

// LAN and SSH-loopback requests must connect directly even when Node enables
// HTTP_PROXY globally. Release downloads keep their separate proxy-aware flow.
const directAgent = new Agent({ keepAlive: true, proxyEnv: {} });

function lanRank(host) {
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    if (a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return 0;
    if (a === 100 && b >= 64 && b <= 127) return 1;
  }
  if (isIP(host) === 6 && /^f[cd]/i.test(host)) return 2;
  return -1;
}

export const isLANAddress = (host) => lanRank(host) >= 0;

function gatewayURL(address) {
  let url;
  try { url = new URL(address.includes("://") ? address : "http://" + address); }
  catch { throw new OperationError("LOCAL_MAGPIE_CONFIG", "Magpie 网关地址无效"); }
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new OperationError("LOCAL_MAGPIE_CONFIG", "自动对接需要不带路径或凭据的局域网 HTTP 网关地址");
  return url;
}

export async function localGateway(directory, env = process.env, { interfaces = networkInterfaces() } = {}) {
  let settings;
  try { settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") throw new OperationError("LOCAL_MAGPIE_LAN_REQUIRED", "请先在本机 Magpie 中开启局域网共享；自动对接不使用 localhost 网关");
    throw new OperationError("LOCAL_MAGPIE_CONFIG", "无法读取本机 Magpie 网关设置");
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new OperationError("LOCAL_MAGPIE_CONFIG", "本机 Magpie 网关设置无效");
  if (settings.lan !== true) throw new OperationError("LOCAL_MAGPIE_LAN_REQUIRED", "请先在本机 Magpie 中开启局域网共享；自动对接不使用 localhost 网关");
  const port = settings.port || 3425;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new OperationError("LOCAL_MAGPIE_CONFIG", "本机 Magpie 网关端口无效");
  const listen = gatewayURL(env.MAGPIE_ADDR || "127.0.0.1:" + port);
  const hosts = [...new Set(Object.values(interfaces).flatMap((entries) => entries ?? []).filter((entry) => !entry.internal && lanRank(entry.address) >= 0).map((entry) => entry.address))].sort((a, b) => lanRank(a) - lanRank(b));
  const makeURL = (host, gatewayPort) => gatewayURL("http://" + (isIP(host) === 6 ? "[" + host + "]" : host) + ":" + gatewayPort);
  let urls;
  if (env.MAGPIE_PUBLIC_URL) {
    const advertised = gatewayURL(env.MAGPIE_PUBLIC_URL);
    const host = advertised.hostname.replace(/^\[|\]$/g, "");
    if (lanRank(host) < 0 || !hosts.includes(host)) throw new OperationError("LOCAL_MAGPIE_CONFIG", "Magpie 共享地址需指向本机实际的局域网网卡地址");
    urls = [advertised];
  } else {
    const host = listen.hostname.replace(/^\[|\]$/g, "");
    if (lanRank(host) >= 0) {
      if (!hosts.includes(host)) throw new OperationError("LOCAL_MAGPIE_CONFIG", "Magpie 网关地址不属于本机的局域网网卡");
      urls = [listen];
    } else if (["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"].includes(host)) {
      // The plugin host normalizes MAGPIE_ADDR to loopback. Use its port with
      // actual LAN interfaces; never turn an unavailable LAN listener into -R localhost.
      urls = hosts.map((address) => makeURL(address, listen.port || 80));
    } else throw new OperationError("LOCAL_MAGPIE_CONFIG", "自动对接需要本机的局域网网关地址");
  }
  if (!urls.length) throw new OperationError("LOCAL_MAGPIE_LAN_REQUIRED", "未找到可用的本机局域网地址，无法转发 Magpie 共享网关");
  let keys = [];
  try { keys = JSON.parse(await readFile(join(directory, "caller-keys.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new OperationError("LOCAL_MAGPIE_CONFIG", "无法读取本机 Magpie 局域网网关密钥"); }
  if (!Array.isArray(keys) || keys.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) throw new OperationError("LOCAL_MAGPIE_CONFIG", "本机 Magpie 网关密钥记录无效");
  const caller = keys.find((entry) => settings.lanKeyId && entry.id === settings.lanKeyId || entry.lan === true);
  const key = caller ? caller.off ? "" : caller.secret : settings.lanKeyId ? "" : settings.lanKey;
  if (typeof key !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(key) || key.startsWith("sk-magpie-revoked-")) {
    throw new OperationError("LOCAL_MAGPIE_KEY", "局域网共享网关密钥缺失、已停用或已撤销，请在本机 Magpie 中检查共享网关密钥");
  }
  const [url, ...alternatives] = urls;
  return { url: url.origin, host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) || 80, key, alternatives: alternatives.map((candidate) => candidate.origin) };
}

export async function magpieJSON(url, { signal, headers, method = "GET", body, timeoutMs = 15000 } = {}) {
  const input = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method, agent: directAgent, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json", ...(input && { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(input) }), ...headers },
    }, (response) => {
      response.on("error", reject);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy(); reject(new OperationError("PROVIDER_LINK_API", "Magpie 对接接口返回错误（HTTP " + response.statusCode + "）")); return;
      }
      void (async () => {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of response) {
          bytes += chunk.byteLength;
          if (bytes > 16 * 1024 * 1024) throw new OperationError("PROVIDER_LINK_API", "Magpie 对接响应超过大小限制");
          chunks.push(chunk);
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { throw new OperationError("PROVIDER_LINK_API", "Magpie 对接接口未返回有效 JSON"); }
      })().catch(reject);
    });
    request.on("error", reject);
    request.end(input);
  });
}

export function magpieSignIn(url, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { agent: directAgent, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }, (response) => {
      response.on("error", reject);
      resolve({ status: response.statusCode, cookies: response.headers["set-cookie"] ?? [] });
      response.destroy();
    });
    request.on("error", reject);
    request.end();
  });
}

const models = new Set(["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/messages/count_tokens", "/v1/systemone", "/v1/embeddings", "/v1/rerank", "/v1/decisions", "/v1/images/generations", "/v1/images/edits", "/v1/videos", "/v1/audio/transcriptions", "/v1/audio/translations", "/v1/audio/speech"]);
function allowed(method, path) {
  if (method === "GET") return ["/", "/v1/models", "/v1/magpie/quotas", "/v1/magpie/quotas/history", "/v1/magpie/usage", "/v1/magpie/usage/requests"].includes(path) || /^\/v1\/videos\/[A-Za-z0-9_-]+(?:\/content)?$/.test(path);
  return method === "POST" && (models.has(path) || /^\/v1beta\/models\/[^/]+:(?:generateContent|streamGenerateContent|countTokens)$/.test(path));
}

// Only model APIs cross this listener. Magpie's local administration, key issuing,
// MCP tools and plugins are never exposed by the automatic reverse forward.
export async function startProviderRelay() {
  const routes = new Map(), sockets = new Set();
  const server = createServer((incoming, outgoing) => {
    let url;
    try { url = new URL(incoming.url, "http://127.0.0.1"); } catch { outgoing.writeHead(400).end(); return; }
    const route = routes.get(url.pathname.split("/")[1]);
    const path = "/" + url.pathname.split("/").slice(2).join("/");
    const supplied = String(incoming.headers["x-api-key"] ?? incoming.headers.authorization?.replace(/^Bearer /i, "") ?? "");
    const equal = route && timingSafeEqual(createHash("sha256").update(supplied).digest(), createHash("sha256").update(route.token).digest());
    if (!equal) { outgoing.writeHead(401).end(); return; }
    if (!allowed(incoming.method, path)) { outgoing.writeHead(403).end(); return; }
    const headers = { ...incoming.headers, authorization: "Bearer " + route.target.key, "x-api-key": route.target.key, host: new URL(route.target.url).host };
    for (const key of ["connection", "proxy-authorization", "cookie", "origin", "referer", "x-forwarded-for", "x-forwarded-host", "forwarded", "sec-fetch-site"]) delete headers[key];
    const request = httpRequest(new URL(path + url.search, route.target.url), { method: incoming.method, headers, agent: directAgent }, (response) => {
      const resultHeaders = { ...response.headers };
      for (const key of ["set-cookie", "connection"]) delete resultHeaders[key];
      outgoing.writeHead(response.statusCode, resultHeaders);
      response.on("error", () => outgoing.destroy());
      response.pipe(outgoing);
    });
    request.on("error", () => { if (outgoing.destroyed) return; if (!outgoing.headersSent) outgoing.writeHead(502).end(); else outgoing.destroy(); });
    request.setTimeout(300000, () => request.destroy());
    incoming.on("aborted", () => request.destroy());
    incoming.on("error", () => request.destroy());
    outgoing.on("error", () => request.destroy());
    outgoing.on("close", () => request.destroy());
    incoming.pipe(request);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    port: server.address().port,
    set(id, token, target) { routes.set(id, { token, target }); },
    remove(id) { routes.delete(id); },
    async close() { routes.clear(); for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); },
  };
}
