import { createServer } from "node:http";
import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, timingSafeEqual } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorDetails } from "./errors.mjs";

const assets = new Map([
  ["", ["manage.html", "text/html; charset=utf-8"]],
  ["app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["recovery.js", ["recovery.js", "text/javascript; charset=utf-8"]],
  ["backups.js", ["backups.js", "text/javascript; charset=utf-8"]],
  ["remote.js", ["remote.js", "text/javascript; charset=utf-8"]],
  ["remote.css", ["remote.css", "text/css; charset=utf-8"]],
  ["icons.js", ["icons.js", "text/javascript; charset=utf-8"]],
  ["app.css", ["app.css", "text/css; charset=utf-8"]],
  ["connection-editor.js", ["connection-editor.js", "text/javascript; charset=utf-8"]],
  ["connection-editor.css", ["connection-editor.css", "text/css; charset=utf-8"]],
  ["forward-editor.css", ["forward-editor.css", "text/css; charset=utf-8"]],
  ["theme.js", ["theme.js", "text/javascript; charset=utf-8"]],
  ["icon.png", ["icon.png", "image/png"]],
  ["icon-dark.png", ["icon-dark.png", "image/png"]],
  ["icon.svg", ["icon.svg", "image/svg+xml"]],
]);

function secureEqual(left, right) {
  const a = Buffer.from(left ?? "");
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function readJSON(request) {
  return new Promise((resolve, reject) => {
    let length = 0;
    let exceeded = false;
    const chunks = [];
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > 65536) {
        if (!exceeded) reject(Object.assign(new Error("请求内容过大"), { status: 413 }));
        exceeded = true;
        chunks.length = 0;
      } else if (!exceeded) chunks.push(chunk);
    });
    request.on("end", () => {
      if (exceeded) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("请求必须是有效的 JSON")); }
    });
    request.on("error", reject);
    request.on("aborted", () => reject(new Error("请求已取消")));
  });
}

export async function loadRecoveryKey(file) {
  async function readKey() {
    const metadata = await lstat(file);
    if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o077))) throw new Error("恢复密钥文件权限无效");
    const saved = JSON.parse(await readFile(file, "utf8"));
    if (saved?.version !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(saved.secret ?? "") || typeof saved.privateKey !== "string") throw new Error("恢复密钥格式无效");
    const privateKey = createPrivateKey({ key: Buffer.from(saved.privateKey, "base64url"), type: "pkcs8", format: "der" });
    if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails.namedCurve !== "prime256v1") throw new Error("恢复密钥类型无效");
    const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64url");
    return { secret: saved.secret, privateKey: saved.privateKey, publicKey };
  }
  try { return await readKey(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const contents = JSON.stringify({ version: 1, secret: randomBytes(32).toString("base64url"), privateKey: key.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url") });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    try { await link(temporary, file); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
  return readKey();
}

export async function startManagementServer({ tools, port = 0, recovery }) {
  const token = randomBytes(32).toString("base64url");
  const prefix = `/${token}/`;
  const signingKey = recovery && createPrivateKey({ key: Buffer.from(recovery.privateKey, "base64url"), type: "pkcs8", format: "der" });
  const pageDirectory = new URL("../page/", import.meta.url);
  let origin;
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (!response.headersSent && !response.destroyed) json(response, error.status ?? 400, {
        ...errorDetails(error), error: error.message,
        ...(error.code === "CREDENTIALS_REQUIRED" && { credentialFields: error.credentialFields }),
      });
      else response.destroy();
    });
  });
  async function handle(request, response) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.headers.host !== new URL(origin).host) return json(response, 403, { error: "不接受该主机名" });
    const url = new URL(request.url, origin);
    const path = url.pathname;
    const requestOrigin = request.headers.origin;
    if (requestOrigin && requestOrigin !== "null" && requestOrigin !== origin) {
      return json(response, 403, { error: "不接受该页面来源" });
    }
    if (requestOrigin) {
      response.setHeader("Access-Control-Allow-Origin", requestOrigin);
      response.setHeader("Vary", "Origin");
    }
    if (path === "/recovery-frame/index.html" && request.method === "GET") {
      const script = await readFile(new URL("recovery-frame.js", pageDirectory), "utf8");
      const nonce = randomBytes(18).toString("base64");
      const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src http:; connect-src ${origin}; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`;
      response.setHeader("Content-Security-Policy", policy);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      const policyMeta = policy.replaceAll("'", "&#39;");
      return response.end(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content='${policyMeta}'><script nonce="${nonce}">${script}</script></head><body></body></html>`);
    }
    const identity = /^\/recovery\/identity\/([A-Za-z0-9_-]{43})$/.exec(path);
    const discovery = /^\/recovery\/endpoint\/([A-Za-z0-9_-]{43})\/([A-Za-z0-9_-]{43})$/.exec(path);
    if ((identity || discovery) && signingKey && request.method === "GET") {
      const challenge = identity ? identity[1] : discovery[2];
      if (discovery) {
        const expected = createHmac("sha256", Buffer.from(recovery.secret, "base64url")).update(origin + "\n" + challenge).digest("base64url");
        if (!secureEqual(discovery[1], expected)) return json(response, 404, { error: "文件不存在" });
      }
      const message = JSON.stringify({ version: 1, purpose: identity ? "identity" : "endpoint", origin, challenge, ...(discovery && { url: `${origin}${prefix}` }) });
      const signature = sign("sha256", Buffer.from(message), { key: signingKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
      return json(response, 200, { message, signature });
    }
    if (request.method === "OPTIONS" && (path.startsWith(prefix + "api/") || /^\/[A-Za-z0-9_-]{43}\/api\//.test(path))) {
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      response.setHeader("Access-Control-Allow-Private-Network", "true");
      response.writeHead(204);
      return response.end();
    }
    if (!path.startsWith(prefix)) return json(response, 404, { error: "管理服务地址已过期", code: "MANAGEMENT_EXPIRED" });
    const relative = path.slice(prefix.length);
    if (relative.startsWith("api/")) {
      if (!secureEqual(request.headers.authorization, `Bearer ${token}`)) return json(response, 401, { error: "管理页面认证已过期，请重新打开页面", code: "MANAGEMENT_EXPIRED" });
      if (request.method === "GET" && relative === "api/snapshot") {
        return json(response, 200, await tools.connections.execute({ includeStatus: true }));
      }
      if (request.method !== "POST" || relative !== "api/call") return json(response, 405, { error: "请求方法不支持" });
      if (!request.headers["content-type"]?.startsWith("application/json")) return json(response, 415, { error: "需要 JSON 请求" });
      const body = await readJSON(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("请求必须是对象");
      const tool = Object.hasOwn(tools, body.method) && tools[body.method];
      if (!tool) throw new Error("未知的管理操作");
      if (!body.args || typeof body.args !== "object" || Array.isArray(body.args)) throw new Error("操作参数必须是对象");
      const credentials = body.credentials;
      if (credentials !== undefined) {
        const fields = body.method === "connect" ? ["password", "passphrase"] : body.method === "save_connection" ? ["password"] : [];
        if (!fields.length || !credentials || typeof credentials !== "object" || Array.isArray(credentials)
          || Object.entries(credentials).some(([key, value]) => !fields.includes(key) || typeof value !== "string" || value.length > 4096
            || (body.method === "save_connection" && !value.length))) {
          throw new Error("本次登录凭据无效");
        }
      }
      const controller = new AbortController();
      const cancel = () => { if (!response.writableEnded) controller.abort(); };
      response.once("close", cancel);
      try {
        const result = await tool.execute(body.args, { abort: controller.signal, credentials });
        if (!response.destroyed) json(response, 200, { result });
      } finally { response.removeListener("close", cancel); }
      return;
    }
    const asset = assets.get(relative);
    if (!asset || !["GET", "HEAD"].includes(request.method)) return json(response, 404, { error: "文件不存在" });
    const data = await readFile(new URL(asset[0], pageDirectory));
    response.setHeader("Content-Security-Policy", [
      "default-src 'none'", `script-src ${origin}`, `style-src ${origin}`,
      `img-src ${origin} data:`, "connect-src http://127.0.0.1:*", "frame-src http://127.0.0.1:* http://localhost:* http://wails.localhost", "object-src 'none'", "base-uri 'none'",
      "form-action 'none'", "sandbox allow-scripts",
      // Magpie's Windows desktop uses Wails' virtual origin rather than a loopback URL.
      "frame-ancestors http://127.0.0.1:* http://localhost:* http://wails.localhost",
    ].join("; "));
    response.writeHead(200, { "Content-Type": asset[1] });
    response.end(request.method === "HEAD" ? undefined : data);
  }
  server.requestTimeout = 55000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  server.unref();
  return {
    url: `${origin}${prefix}`, token,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}

export async function publishEndpoint(file, url, recovery) {
  const owner = randomBytes(16).toString("base64url");
  const contents = `window.__migpieRemoteEndpoint = ${JSON.stringify({ url, owner, ...(recovery && { recovery: { secret: recovery.secret, publicKey: recovery.publicKey } }) })};\n`;
  const discoveryFile = join(dirname(file), "discovery.css");
  const discovery = `/* ${owner} */\n:root { --migpie-management-port: ${new URL(url).port}; }\n`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  async function publish(path, data) {
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try { await writeFile(temporary, data, { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  await publish(discoveryFile, discovery);
  try { await publish(file, contents); }
  catch (error) {
    try { if (readFileSync(discoveryFile, "utf8") === discovery) unlinkSync(discoveryFile); } catch { /* Already removed or replaced. */ }
    throw error;
  }
  const remove = () => {
    for (const [path, data] of [[file, contents], [discoveryFile, discovery]]) {
      try { if (readFileSync(path, "utf8") === data) unlinkSync(path); } catch { /* Already removed or owned by a newer host. */ }
    }
    process.removeListener("exit", remove);
  };
  process.once("exit", remove);
  return remove;
}
