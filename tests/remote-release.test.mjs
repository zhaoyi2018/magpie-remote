import test from "node:test";
import assert from "node:assert/strict";
import { latestRelease, parseRelease } from "../src/remote.mjs";

const version = "0.1.3356";
const officialURL = (arch = "amd64") => `https://usemagpie.ai/files/v${version}/magpie-cli-linux-${arch}`;
const githubURL = (arch = "amd64") => `https://github.com/yetone/magpie-releases/releases/download/v${version}/magpie-cli-linux-${arch}`;

// Relevant fields from the official feed after asset.url moved to usemagpie.ai/files/.
function feed() {
  return { version, assets: {
    "magpie-cli-linux-amd64": {
      url: officialURL(), github: githubURL(), size: 73556130,
      sha256: "6a3c43feead0c6999711a855df66823a5c21593a10a2c291099c474c5eb756e4",
    },
    "magpie-cli-linux-arm64": {
      url: officialURL("arm64"), github: githubURL("arm64"), size: 67829922,
      sha256: "7f5760ea3a4aef490b63626f37cd45a90af25ef27c9c94a22588d1c2dd16e5d0",
    },
  } };
}

test("official file URLs and legacy GitHub URLs resolve the correct Linux CLI asset", () => {
  for (const [architecture, arch] of [["x86_64", "amd64"], ["amd64", "amd64"], ["aarch64", "arm64"], ["arm64", "arm64"]]) {
    for (const url of [officialURL(arch), githubURL(arch), githubURL(arch).replace(`/v${version}/`, `/${version}/`)]) {
      const data = feed(), asset = data.assets[`magpie-cli-linux-${arch}`];
      asset.url = url;
      asset.sha256 = asset.sha256.toUpperCase();
      assert.deepEqual(parseRelease(data, architecture), { version, url, sha256: asset.sha256.toLowerCase(), size: asset.size });
      data.version = "v" + version;
      assert.equal(parseRelease(data, architecture).version, "v" + version);
    }
  }
});

test("unsupported or incomplete feeds fail with a release error instead of a TypeError", () => {
  for (const data of [null, [], "invalid", {}, { version }, { ...feed(), version: "latest" }, { ...feed(), version: 123 }]) {
    assert.throws(() => parseRelease(data, "amd64"), { code: "REMOTE_RELEASE_INVALID" });
  }
  for (const patch of [{ sha256: undefined }, { sha256: "invalid" }, { url: undefined }, { url: 123 }]) {
    const data = feed();
    Object.assign(data.assets["magpie-cli-linux-amd64"], patch);
    assert.throws(() => parseRelease(data, "amd64"), { code: "REMOTE_RELEASE_INVALID" });
  }
});

test("release URLs must match the official source, version and architecture", () => {
  for (const url of [
    "not a URL", officialURL().replace("https:", "http:"),
    officialURL().replace("usemagpie.ai", "usemagpie.ai.example.com"),
    officialURL().replace("usemagpie.ai", "downloads.example.com"),
    officialURL().replace("/files/", "/other/"),
    officialURL().replace(version, "0.1.1"), officialURL("arm64"),
    officialURL().replace("magpie-cli-", "magpie-"),
    officialURL().replace("usemagpie.ai", "usemagpie.ai:8443"),
    officialURL().replace("usemagpie.ai", "user:password@usemagpie.ai"),
    officialURL() + "?redirect=1", officialURL() + "#asset",
    githubURL().replace("yetone/magpie-releases", "someone/magpie-releases"),
    githubURL().replace(version, "0.1.1"), githubURL("arm64"),
    githubURL().replace("/releases/download/", "/releases/download/extra/"),
    githubURL().replace("github.com", "github.com:8443"),
    githubURL() + "?download=1", githubURL() + "#asset",
  ]) {
    const data = feed();
    data.assets["magpie-cli-linux-amd64"].url = url;
    assert.throws(() => parseRelease(data, "amd64"), { code: "REMOTE_RELEASE_INVALID" }, url);
  }
});

test("optional asset size never supplies invalid download totals", () => {
  for (const size of [undefined, null, 0, -1, 1.5, "73556130", 1e12 + 1]) {
    const data = feed();
    data.assets["magpie-cli-linux-amd64"].size = size;
    assert.equal(Object.hasOwn(parseRelease(data, "amd64"), "size"), false);
  }
});

test("latestRelease reads and validates the current official feed", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://usemagpie.ai/api/latest");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(feed());
  });
  assert.deepEqual(await latestRelease("x86_64"), parseRelease(feed(), "amd64"));
  assert.deepEqual(await latestRelease("aarch64"), parseRelease(feed(), "arm64"));
  assert.equal(mocked.mock.callCount(), 2);
  await assert.rejects(latestRelease("riscv64"), { code: "REMOTE_UNSUPPORTED" });
  assert.equal(mocked.mock.callCount(), 2);
});

test("feed transport and JSON errors stay distinct from unsupported release data", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("fixture network error"); });
  await assert.rejects(latestRelease("amd64"), { code: "REMOTE_RELEASE_UNAVAILABLE" });
  for (const response of [new Response("unavailable", { status: 503 }), new Response("not JSON"), new Response(" ".repeat(262145))]) {
    globalThis.fetch.mock.mockImplementation(async () => response);
    await assert.rejects(latestRelease("amd64"), { code: "REMOTE_RELEASE_UNAVAILABLE" });
  }
  globalThis.fetch.mock.mockImplementation(async () => Response.json(null));
  await assert.rejects(latestRelease("amd64"), { code: "REMOTE_RELEASE_INVALID" });
});
