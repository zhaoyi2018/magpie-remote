import { readFile } from "node:fs/promises";
import { openWebBrowser } from "../src/browser.mjs";

try {
  const source = await readFile(new URL("../page/.runtime/endpoint.js", import.meta.url), "utf8");
  const match = /^window\.__migpieRemoteEndpoint = (.+);\s*$/u.exec(source);
  if (!match) throw new Error("启动地址无法读取，请重新加载插件后重试");
  let endpoint;
  try { endpoint = new URL(JSON.parse(match[1]).url); }
  catch { throw new Error("启动地址无法读取，请重新加载插件后重试"); }
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || !/^\/[A-Za-z0-9_-]{43}\/$/.test(endpoint.pathname)) {
    throw new Error("启动地址无效，请重新加载插件后重试");
  }
  const response = await fetch(new URL("api/snapshot", endpoint), {
    headers: { Authorization: "Bearer " + endpoint.pathname.split("/")[1] },
    redirect: "error", signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || !Array.isArray((await response.json()).connections)) throw new Error("当前管理服务不可用，请确认 Magpie 中的插件已启用");
  await openWebBrowser(endpoint.href);
  console.log("已在默认浏览器打开 SSH 连接管理，共用当前插件的连接配置和会话。");
} catch (error) {
  console.error(error.code === "ENOENT" ? "插件尚未发布管理地址，请先在 Magpie 中启用插件。" : "无法打开连接管理：" + (error.name === "TimeoutError" || error instanceof TypeError ? "管理服务无法连接，请确认插件仍在运行。" : error.message));
  process.exitCode = 1;
}
