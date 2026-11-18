import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { chromium } from "playwright";
import { publishDesktopLauncher } from "../src/desktop-launcher.mjs";
import { loadRecoveryKey, startDesktopRecovery, startManagementServer } from "../src/web-server.mjs";
import { managementView } from "../src/management-view.mjs";
import { startUIHarness } from "./ui-harness.mjs";

const directory = await mkdtemp(join(tmpdir(), "migpie-native-ui-"));
const launcherFile = join(directory, "index.html");
const viewFile = join(directory, "view.json"), portFile = join(directory, "recovery-port");
const operation = { id: "28bc493a-a20d-45a7-b6a6-999ba63ac532", action: "install", state: "succeeded", message: "测试任务已完成" };
const records = ["first", "second"].map((id) => ({
  connection: { id, name: id === "second" ? "第二台" : "第一台", host: "127.0.0.1", port: 22, username: "fixture", forwards: [] },
  session: { id, state: "disconnected", forwards: [] },
}));
const taskReads = [], submissions = [];
const tools = {
  connections: { execute: () => ({ connections: records }) },
  remote_status: { execute: ({ connectionId }) => ({ connectionId, ...(connectionId === "second" && { operation }) }) },
  remote_operation: { execute: (args) => { taskReads.push(args); return operation; } },
  remote_apply: { execute: (args) => { submissions.push(args); } },
};
let browser, harness, web, replacement, discovery, unpublish;
try {
  const recovery = await loadRecoveryKey(join(directory, "recovery-key"));
  const view = managementView(viewFile);
  web = await startManagementServer({ tools, view, recovery });
  discovery = await startDesktopRecovery({ file: portFile, endpoint: web.url, recovery });
  const origin = discovery.origin;
  unpublish = await publishDesktopLauncher(launcherFile, web.url, { origin, recovery });
  harness = await startUIHarness({ launcherFile });
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
  await page.keyboard.press("Escape");
  assert.equal(hostSubresources, 0, "Native entry must not depend on any host-served script, style or second HTML file");
  assert.deepEqual(errors, []);
  const assets = await frame.locator("body").evaluate(() => ({ styles: document.styleSheets.length, brokenImages: [...document.images].filter((image) => !image.complete || !image.naturalWidth).length }));
  assert.equal(assets.styles, 4);
  assert.equal(assets.brokenImages, 0);
  const viewSaved = page.waitForResponse((response) => {
    if (!response.url().endsWith("/api/view") || !response.ok()) return false;
    return response.request().postDataJSON()?.operationId === operation.id;
  });
  void viewSaved.catch(() => {});
  await frame.getByRole("button", { name: /^第二台，/ }).click();
  await frame.locator("#tab-remote").click();
  await viewSaved;
  await view.close();
  replacement = await startManagementServer({ tools, view: managementView(viewFile), recovery });
  const newOrigin = new URL(replacement.url).origin;
  assert.notEqual(newOrigin, new URL(web.url).origin);
  await web.close();
  await discovery.close();
  discovery = null;
  await frame.getByRole("button", { name: "重新连接", exact: true }).waitFor({ timeout: 15000 });
  const migrated = page.waitForEvent("framenavigated", { predicate: (child) => child.url().startsWith(replacement.url), timeout: 15000 });
  void migrated.catch(() => {});
  discovery = await startDesktopRecovery({ file: portFile, endpoint: replacement.url, recovery });
  assert.equal(discovery.origin, origin);
  await frame.getByRole("button", { name: "重新连接", exact: true }).click();
  await migrated;
  await frame.locator("#service-state").filter({ hasText: "管理服务在线" }).waitFor({ timeout: 15000 });
  await frame.locator("#tab-remote[aria-selected=true]").waitFor();
  await frame.locator("#remote-task-state").filter({ hasText: "已完成" }).waitFor();
  assert.ok(page.frames().some((child) => child.url().startsWith(replacement.url)));
  assert.deepEqual(taskReads, [{ connectionId: "second", operationId: operation.id }]);
  assert.deepEqual(submissions, []);
  assert.deepEqual(errors, []);
  console.log("Desktop launcher passed: sandbox hello, online management, cross-port recovery, restored connection, tab and task, zero operation replays.");
} finally {
  await browser?.close();
  await harness?.close();
  unpublish?.();
  await discovery?.close();
  await replacement?.close();
  await web?.close();
  const verified = await realpath(directory);
  if (dirname(verified) !== await realpath(tmpdir()) || !basename(verified).startsWith("migpie-native-ui-")) throw new Error("Unexpected temporary directory");
  await rm(verified, { recursive: true, force: true });
}
