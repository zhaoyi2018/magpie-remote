import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function openWebBrowser(url, { platform = process.platform, execute = run } = {}) {
  if (typeof url !== "string" || !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/\?k=[A-Za-z0-9._~-]{16,256}$/.test(url) || /\s/.test(url)) throw new Error("无效的本机 Web 地址，请重新获取。");
  const port = Number(url.match(/:([0-9]+)\//)[1]);
  if (port < 1 || port > 65535) throw new Error("无效的本机 Web 端口，请重新获取。");
  const command = platform === "win32" ? "rundll32.exe" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    await execute(command, args, { windowsHide: true, timeout: 10000 });
  } catch {
    throw new Error("无法打开本机浏览器，请复制地址到浏览器访问。");
  }
}
