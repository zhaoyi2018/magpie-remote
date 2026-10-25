import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { ProfileStore, profileRevision, publicProfile } from "../src/store.mjs";
import { SessionManager } from "../src/sessions.mjs";
import { createTools } from "../src/plugin.mjs";
import { startManagementServer } from "../src/web-server.mjs";
import { echoServer, exchange, sshServer, temporary, until } from "../tests/helpers.mjs";
import { startUIHarness } from "./ui-harness.mjs";

const cleanup = [];
const context = { after(fn) { cleanup.unshift(fn); } };
const releaseRequests = [];
try {
  const directory = await temporary(context);
  const fixture = await sshServer(context), echo = await echoServer(context);
  const store = new ProfileStore(join(directory, "connections.json"));
  const sessions = new SessionManager({ env: {} });
  cleanup.unshift(() => sessions.close());
  const tools = createTools(store, sessions);
  const web = await startManagementServer({ tools });
  cleanup.unshift(() => web.close());
  const harness = await startUIHarness({ getEndpoint: () => web.url });
  cleanup.unshift(() => harness.close());
  const executable = process.env.MIGPIE_UI_BROWSER;
  const browserOptions = executable ? { executablePath: resolve(executable) } : {};
  if (!executable && !existsSync(chromium.executablePath())) {
    if (process.platform === "win32") browserOptions.channel = "msedge";
    else throw new Error("Chromium is not installed. Run npx playwright install chromium, or set MIGPIE_UI_BROWSER to a Chromium executable.");
  }
  const browser = await chromium.launch({ ...browserOptions, headless: true });
  cleanup.unshift(() => browser.close());
  const browserContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["local-network-access"] });
  const page = await browserContext.newPage();
  const scriptErrors = [];
  page.on("pageerror", (error) => scriptErrors.push(error.message));
  const counts = new Map();
  const api = new URL("api/call", web.url).href;
  page.on("request", (request) => {
    if (request.url() === api && request.method() === "POST") {
      const { method } = request.postDataJSON();
      counts.set(method, (counts.get(method) ?? 0) + 1);
    }
  });
  await page.goto(harness.url);
  const ui = page.frameLocator('iframe[title="SSH 连接"]');
  const field = (id) => ui.locator("#" + id);
  await field("service-state").filter({ hasText: "管理服务在线" }).waitFor();
  assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts");

  // Submit through Enter inside the same CSP sandbox used by the host page.
  await field("new-connection").click();
  await field("profile-name").fill("UI regression");
  await field("profile-host").fill(fixture.profile.host);
  await field("profile-port").fill(String(fixture.port));
  await field("profile-username").fill(fixture.profile.username);
  await ui.locator('[data-auth="password"]').click();
  await field("profile-password").fill("local-test-secret");
  await field("profile-host-advanced").locator("summary").click();
  await field("profile-id").fill("ui-regression");
  await field("profile-fingerprint").fill(fixture.profile.hostFingerprint);
  await field("profile-known-hosts").fill(fixture.profile.knownHostsFile);
  await field("profile-password").press("Enter");
  await ui.locator("#connection-editor[open]").waitFor({ state: "hidden" });
  await field("detail-state").filter({ hasText: "已连接" }).waitFor();
  assert.equal(counts.get("save_connection"), 1);
  assert.equal(counts.get("connect"), 1);
  assert.equal(await field("profile-password").inputValue(), "");
  assert.equal(await field("credential-dialog").evaluate((node) => node.open), false);
  assert.ok(!(await readFile(store.file, "utf8")).includes("local-test-secret"));
  const originalPassword = (await store.get("ui-regression")).encryptedPassword;

  await field("disconnect").click();
  await field("detail-state").filter({ hasText: "未连接" }).waitFor();
  await field("tab-connection").click();
  await field("edit-connection").click();
  assert.equal(await field("profile-password").inputValue(), "");
  await field("profile-name").fill("UI edited");
  await field("save-connection").click();
  await ui.locator("#connection-editor[open]").waitFor({ state: "hidden" });
  assert.deepEqual((await store.get("ui-regression")).encryptedPassword, originalPassword);
  await field("tab-connection").click();
  await field("edit-connection").click();
  await field("profile-password").fill("discard-this-draft");
  await ui.locator("#connection-editor .dialog-actions .close-dialog").click();
  assert.equal(await field("profile-password").inputValue(), "");
  assert.deepEqual((await store.get("ui-regression")).encryptedPassword, originalPassword);
  console.log("UI: password save, single Enter submission, blank edit preservation and cancelled-password cleanup passed.");

  await field("edit-connection").click();
  await field("profile-name").fill("Local conflict draft");
  const current = await store.get("ui-regression");
  await tools.save_connection.execute({ connection: { ...publicProfile(current), name: "External edit" }, expectedRevision: profileRevision(current) });
  await field("save-connection").click();
  await field("profile-error").filter({ hasText: "配置已被修改" }).waitFor();
  assert.equal(await field("connection-editor").evaluate((node) => node.open), true);
  assert.equal(await field("profile-name").inputValue(), "Local conflict draft");
  assert.equal((await store.get("ui-regression")).name, "External edit");
  await ui.locator("#connection-editor .dialog-actions .close-dialog").click();
  await field("refresh").click();
  await field("detail-name").filter({ hasText: "External edit" }).waitFor();
  await field("edit-connection").click();
  assert.equal(await field("profile-name").inputValue(), "External edit");
  await ui.locator("#connection-editor .dialog-actions .close-dialog").click();
  console.log("UI: concurrent tool edit rejects stale save, retains the draft and reloads the current configuration.");

  await field("tab-forwards").click();
  await field("connect").click();
  await field("detail-state").filter({ hasText: "已连接" }).waitFor();
  const createForward = async (name, direction = "c2s") => {
    await field("new-forward").click();
    await field("rule-name").fill(name);
    await field("rule-bind-port").fill("0");
    await field("rule-target-port").fill(String(echo.port));
    await field("rule-direction-" + direction).check();
  };
  const assertBusyDialog = async () => {
    assert.equal(await field("forward-editor").getAttribute("aria-busy"), "true");
    assert.ok(await ui.locator("#forward-editor .close-dialog").evaluateAll((nodes) => nodes.every((node) => node.disabled)));
    await ui.locator("#forward-editor .close-dialog").evaluateAll((nodes) => nodes.forEach((node) => node.click()));
    await page.keyboard.press("Escape");
    assert.equal(await field("forward-editor").evaluate((node) => node.open), true);
    assert.equal(await field("save-forward").isDisabled(), true);
  };
  const hold = (method, execute) => {
    let entered = false;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    tools[method].execute = async (...args) => { entered = true; await gate; return execute(...args); };
    releaseRequests.push(release);
    return { entered: () => entered, release };
  };
  const save = tools.forward_save.execute;
  const add = tools.forward_add.execute;
  const heldSave = hold("forward_save", save);
  const heldAdd = hold("forward_add", add);
  const saveCount = counts.get("forward_save") ?? 0, addCount = counts.get("forward_add") ?? 0;
  await createForward("Delayed local forward");
  await field("rule-target-port").press("Enter");
  await until(heldSave.entered, "The page did not submit its forward preset");
  await assertBusyDialog();
  heldSave.release();
  await until(heldAdd.entered, "The page did not start its saved forward");
  await assertBusyDialog();
  heldAdd.release();
  await ui.locator("#forward-editor[open]").waitFor({ state: "hidden" });
  tools.forward_save.execute = save; tools.forward_add.execute = add;
  assert.equal(counts.get("forward_save"), saveCount + 1);
  assert.equal(counts.get("forward_add"), addCount + 1);
  const live = sessions.status("ui-regression").forwards[0];
  assert.ok((await exchange(live.bindPort)).length);

  tools.forward_add.execute = async () => { throw new Error("UI test: start rejected"); };
  await createForward("Saved but not started", "s2c");
  await field("save-forward").click();
  await field("rule-error").filter({ hasText: "预设已保存，但启动失败" }).waitFor();
  assert.equal(await field("forward-editor").evaluate((node) => node.open), true);
  assert.ok((await store.get("ui-regression")).forwards.some((forward) => forward.name === "Saved but not started"));
  await until(() => field("save-forward").isEnabled());
  await ui.locator("#forward-editor .dialog-actions .close-dialog").click();
  tools.forward_add.execute = add;
  console.log("UI: delayed save/start keeps the dialog open, submits once and exposes partial start failures; c2s data round trip passed.");

  await page.setViewportSize({ width: 555, height: 720 });
  await createForward("Narrow dialog");
  assert.ok(await field("save-forward").isVisible());
  assert.equal(await field("forward-editor").evaluate((node) => node.scrollWidth > node.clientWidth + 1), false);
  await ui.locator("#forward-editor .dialog-actions .close-dialog").click();
  assert.equal(await field("connection-detail").evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  const screenshotDirectory = resolve(process.env.MIGPIE_UI_ARTIFACTS ?? ".local/ui-regression");
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: join(screenshotDirectory, "narrow.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: join(screenshotDirectory, "desktop.png"), fullPage: true });
  assert.ok((await stat(join(screenshotDirectory, "desktop.png"))).size > 1000);
  assert.deepEqual(scriptErrors, [], "Browser script errors");
  console.log(`UI: sandboxed desktop/narrow layout and browser script errors passed. Screenshots: ${screenshotDirectory}`);
} finally {
  for (const release of releaseRequests) release();
  for (const fn of cleanup) await fn();
}
