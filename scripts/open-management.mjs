import { readFile } from "node:fs/promises";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { openWebBrowser } from "../src/browser.mjs";

try {
  const check = process.argv.includes("--check");
  const source = await readFile(new URL("../page/.runtime/endpoint.js", import.meta.url), "utf8");
  const match = /^window\.__migpieRemoteEndpoint = (.+);\s*$/u.exec(source);
  if (!match) throw new Error("启动地址无法读取，请重新加载插件后重试");
  let endpoint, recovery;
  try {
    const publication = JSON.parse(match[1]);
    endpoint = new URL(publication.url);
    recovery = publication.recovery;
  }
  catch { throw new Error("启动地址无法读取，请重新加载插件后重试"); }
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || !/^\/[A-Za-z0-9_-]{43}\/$/.test(endpoint.pathname)) {
    throw new Error("启动地址无效，请重新加载插件后重试");
  }
  if (recovery?.publicKey) {
    const challenge = randomBytes(32).toString("base64url");
    const identity = await fetch(new URL("/recovery/identity/" + challenge, endpoint), { redirect: "error", signal: AbortSignal.timeout(3000) });
    let verified = false;
    try {
      const { message, signature } = await identity.json();
      const publicKey = createPublicKey({ key: Buffer.from(recovery.publicKey, "base64url"), type: "spki", format: "der" });
      const data = JSON.parse(message);
      verified = identity.ok && data.version === 1 && data.purpose === "identity" && data.origin === endpoint.origin && data.challenge === challenge
        && verify("sha256", Buffer.from(message), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
    } catch {}
    if (!verified) throw new Error("已发布的地址无法验证管理后台身份，请从 Magpie 侧栏重新打开插件");
  }
  const response = await fetch(new URL("api/snapshot", endpoint), {
    headers: { Authorization: "Bearer " + endpoint.pathname.split("/")[1] },
    redirect: "error", signal: AbortSignal.timeout(5000),
  });
  if ([401, 404].includes(response.status)) throw new Error("管理后台已更换地址，请重新打开插件");
  if (!response.ok || !Array.isArray((await response.json()).connections)) throw new Error("管理后台可达，但连接状态读取失败");
  if (check) {
    console.log("管理后台身份及连接状态检查通过。如果内嵌页仍报错，请在 Magpie 控制台区分入口资源加载失败与未捕获脚本异常。");
  } else {
    await openWebBrowser(endpoint.href);
    console.log("已在默认浏览器打开 SSH 连接管理，共用当前插件的连接配置和会话。");
  }
} catch (error) {
  console.error(error.code === "ENOENT" ? "插件尚未发布管理地址，请先在 Magpie 中启用插件。" : "无法打开连接管理：" + (error.name === "TimeoutError" || error instanceof TypeError ? "管理服务无法连接，请确认插件仍在运行。" : error.message));
  process.exitCode = 1;
}
