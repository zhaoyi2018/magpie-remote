import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { publishFile } from "./publish-file.mjs";

// Keep the entry present while the host is stopped: Magpie discovers the page
// before starting its backend. No script or other host-served file is needed.
export const desktopPlaceholder = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="3">
<title>SSH 连接</title>
<style>body{font:15px system-ui,sans-serif;margin:48px;color:#555}h1{font-size:22px}</style>
</head><body><h1>SSH 连接</h1><p role="status">正在启动连接管理…</p>
<p>若长时间未打开，请在插件设置中确认 SSH 连接已启用，然后重新打开此页。</p></body></html>
`;

export async function publishDesktopLauncher(file, endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { /* Report no credentials. */ }
  if (!url || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || Number(url.port) < 1
    || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_-]{43}\/$/.test(url.pathname)) {
    throw new Error("无效的桌面管理地址");
  }
  const owner = randomBytes(16).toString("hex");
  const contents = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<!-- ${owner} -->
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url=${url.href}">
<title>SSH 连接</title></head><body><p role="status">正在打开连接管理…</p></body></html>\n`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await publishFile(file, contents);
  const remove = () => {
    try {
      if (readFileSync(file, "utf8") === contents) writeFileSync(file, desktopPlaceholder, { mode: 0o600 });
    } catch { /* Already removed or replaced by another host. */ }
    process.removeListener("exit", remove);
  };
  process.once("exit", remove);
  return remove;
}
