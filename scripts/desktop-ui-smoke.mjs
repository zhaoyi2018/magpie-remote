import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { publishDesktopLauncher } from "../src/desktop-launcher.mjs";
import { startManagementServer } from "../src/web-server.mjs";
import { startUIHarness } from "./ui-harness.mjs";

const directory = await mkdtemp(join(tmpdir(), "migpie-native-ui-"));
const launcherFile = join(directory, "index.html");
const web = await startManagementServer({ tools: { connections: { execute: async () => ({ connections: [] }) } } });
const unpublish = await publishDesktopLauncher(launcherFile, web.url);
const harness = await startUIHarness({ launcherFile });
let browser;
try {
  browser = await chromium.launch({ ...(process.platform === "win32" && { channel: "msedge" }), headless: true });
  const context = await browser.newContext({ permissions: ["local-network-access"] });
  let hostSubresources = 0;
  await context.route("**/_magpie/plugin/**", (route) => {
    if (route.request().isNavigationRequest()) return route.continue();
    hostSubresources++;
    return route.abort("connectionrefused");
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(harness.url);
  const frame = page.frameLocator('iframe[title="SSH 连接"]');
  await frame.locator("#service-state").filter({ hasText: "管理服务在线" }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.pluginState), "ready");
  await frame.locator("#new-connection").click();
  await frame.getByRole("dialog").waitFor();
  assert.equal(hostSubresources, 0, "Native entry must not depend on any host-served script, style or second HTML file");
  assert.deepEqual(errors, []);
  const assets = await frame.locator("body").evaluate(() => ({ styles: document.styleSheets.length, brokenImages: [...document.images].filter((image) => !image.complete || !image.naturalWidth).length }));
  assert.equal(assets.styles, 4);
  assert.equal(assets.brokenImages, 0);
  console.log("Desktop launcher passed: sandbox hello, online management, four stylesheets, intact images, interactive connection editor, zero host subresources or script errors.");
} finally {
  await browser?.close();
  await harness.close();
  unpublish();
  await web.close();
  await rm(directory, { recursive: true, force: true });
}
