import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { downloadRelease } from "../src/release-download.mjs";

const binary = Buffer.from(Array.from({ length: 65536 }, (_, index) => index % 256));
const release = { url: "https://usemagpie.ai/files/v0.1.3356/magpie-cli-linux-amd64", sha256: createHash("sha256").update(binary).digest("hex"), size: binary.length };

test("local download follows HTTPS redirects, verifies binary bytes and cleans its private temporary file", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.redirect, "manual");
    requests++;
    if (requests === 1) return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/fixture" } });
    assert.equal(url.href, "https://release-assets.githubusercontent.com/fixture");
    return new Response(binary);
  });
  const samples = [];
  const artifact = await downloadRelease(release, { onProgress: (...sample) => samples.push(sample) });
  t.after(artifact.cleanup);
  assert.deepEqual(await readFile(artifact.path), binary);
  assert.equal(artifact.size, binary.length);
  assert.deepEqual(samples.at(-1), [binary.length, binary.length]);
  await artifact.cleanup();
  await assert.rejects(access(artifact.path), { code: "ENOENT" });
});

test("corrupt, truncated and oversized downloads cannot produce an upload artifact", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(binary));
  for (const asset of [{ ...release, sha256: "0".repeat(64) }, { ...release, size: binary.length + 1 }, { ...release, size: binary.length - 1 }]) {
    await assert.rejects(downloadRelease(asset), { code: "LOCAL_RELEASE_INVALID" });
  }
});

test("failed requests and insecure redirects stop before any file can be uploaded", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(downloadRelease(release), { code: "LOCAL_DOWNLOAD_FAILED" });
  for (const location of ["http://example.com/binary", "https://user:password@example.com/binary"]) {
    mocked.mock.mockImplementation(async () => new Response(null, { status: 302, headers: { location } }));
    const before = mocked.mock.callCount();
    await assert.rejects(downloadRelease(release), { code: "LOCAL_DOWNLOAD_FAILED" });
    assert.equal(mocked.mock.callCount(), before + 1);
  }
});

test("shutdown cancellation aborts an active local download", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    controller.abort();
    signal.throwIfAborted();
  });
  await assert.rejects(downloadRelease(release, { signal: controller.signal }), { code: "LOCAL_DOWNLOAD_FAILED" });
});
