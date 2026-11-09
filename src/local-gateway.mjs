import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import { OperationError } from "./errors.mjs";

export async function localGateway(directory, env = process.env) {
  let address = env.MAGPIE_ADDR;
  if (!address) {
    let settings = {};
    try { settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new OperationError("LOCAL_MAGPIE_CONFIG", "无法读取本机 Magpie 网关设置"); }
    const port = settings.port || 3425;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new OperationError("LOCAL_MAGPIE_CONFIG", "本机 Magpie 网关端口无效");
    address = "127.0.0.1:" + port;
  }
  let url;
  try { url = new URL(address.includes("://") ? address : "http://" + address); }
  catch { throw new OperationError("LOCAL_MAGPIE_CONFIG", "本机 Magpie 网关地址无效"); }
  if (["0.0.0.0", "[::]"].includes(url.hostname)) url.hostname = "127.0.0.1";
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new OperationError("LOCAL_MAGPIE_CONFIG", "自动对接需要本机 Magpie 的回环 HTTP 网关地址");
  }
  return { url: url.origin, host: url.hostname === "[::1]" ? "::1" : url.hostname, port: Number(url.port) || 80 };
}

export async function magpieJSON(url, { signal, headers, method = "GET", body } = {}) {
  const response = await fetch(url, {
    method, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    headers: { Accept: "application/json", ...(body && { "Content-Type": "application/json" }), ...headers },
    ...(body && { body: JSON.stringify(body) }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new OperationError("PROVIDER_LINK_API", "Magpie 对接接口返回错误（HTTP " + response.status + "）"); }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 16 * 1024 * 1024) throw new OperationError("PROVIDER_LINK_API", "Magpie 对接响应超过大小限制");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new OperationError("PROVIDER_LINK_API", "Magpie 对接接口未返回有效 JSON"); }
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
    const headers = { ...incoming.headers, authorization: "Bearer magpie", "x-api-key": "magpie", host: new URL(route.target.url).host };
    for (const key of ["connection", "proxy-authorization", "cookie", "origin", "referer", "x-forwarded-for", "x-forwarded-host", "forwarded", "sec-fetch-site"]) delete headers[key];
    const request = httpRequest(new URL(path + url.search, route.target.url), { method: incoming.method, headers }, (response) => {
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
