import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationError } from "./errors.mjs";

const maximumBytes = 512 * 1024 * 1024;

export async function downloadRelease(release, { signal, onProgress } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "magpie-remote-release-"));
  const path = join(directory, "magpie");
  const cleanup = () => rm(directory, { recursive: true, force: true, maxRetries: 3 });
  let file;
  try {
    const abort = AbortSignal.any([AbortSignal.timeout(300000), ...(signal ? [signal] : [])]);
    let url = new URL(release.url), response;
    for (let redirects = 0; ; redirects++) {
      if (url.protocol !== "https:" || url.username || url.password || redirects > 5) throw new Error("invalid download redirect");
      response = await fetch(url, { signal: abort, redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("missing redirect location");
      url = new URL(location, url);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("release download unavailable");
    }
    const digest = createHash("sha256");
    let size = 0;
    file = await open(path, "wx", 0o600);
    onProgress?.(0, release.size ?? 0);
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maximumBytes || (release.size && size > release.size)) throw new OperationError("LOCAL_RELEASE_INVALID", "本机下载的程序大小与官方清单不符或超过限制，未上传到服务器");
      digest.update(chunk);
      await file.writeFile(chunk);
      onProgress?.(size, release.size ?? 0);
    }
    await file.close(); file = undefined;
    if (!size || (release.size && size !== release.size) || digest.digest("hex") !== release.sha256) throw new OperationError("LOCAL_RELEASE_INVALID", "本机下载的程序未通过大小或 SHA-256 校验，未上传到服务器");
    return { path, size, cleanup };
  } catch (cause) {
    await file?.close().catch(() => {});
    await cleanup();
    if (cause instanceof OperationError) throw cause;
    throw new OperationError("LOCAL_DOWNLOAD_FAILED", signal?.aborted ? "本机下载已中止，未执行远端安装或更新" : "本机下载 Magpie 失败，请检查本机网络、代理和临时目录后重试；未执行远端安装或更新", { cause });
  }
}
