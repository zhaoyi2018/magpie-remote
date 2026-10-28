import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { ProfileStore, profileRevision, publicProfile } from "../src/store.mjs";
import { SessionManager } from "../src/sessions.mjs";
import { createTools } from "../src/plugin.mjs";
import { startManagementServer, loadRecoveryKey } from "../src/web-server.mjs";
import { echoServer, exchange, sshServer, temporary, until } from "../tests/helpers.mjs";
import { startUIHarness } from "./ui-harness.mjs";

const cleanup = [];
const context = { after(fn) { cleanup.unshift(fn); } };
const releaseRequests = [];
try {
  const directory = await temporary(context);
  const fixture = await sshServer(context), echo = await echoServer(context);
  let blockCleanup = false;
  const store = new ProfileStore(join(directory, "connections.json"), { backupLimit: 2, removeFile: async (path, options) => {
    if (blockCleanup) throw new Error("fixture cleanup blocked");
    return rm(path, options);
  }, onWarning() {} });
  const sessions = new SessionManager({ env: {} });
  cleanup.unshift(() => sessions.close());
  const tools = createTools(store, sessions);
  const recovery = await loadRecoveryKey(join(directory, "recovery.key"));
  let web = await startManagementServer({ tools, recovery });
  cleanup.unshift(() => web.close());
  let discoveryOverride = null;
  const harness = await startUIHarness({ getEndpoint: () => web.url, recovery, discoveryStyle: () => discoveryOverride ?? `:root { --migpie-management-port: ${new URL(web.url).port}; }` });
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
  const snapshotURL = new URL("api/snapshot", web.url).href;
  let failSnapshot = true;
  await browserContext.route(snapshotURL, async (route) => {
    if (route.request().method() === "GET" && failSnapshot) { failSnapshot = false; await route.abort("failed"); }
    else await route.continue();
  });
  await field("refresh").click();
  await field("service-state").filter({ hasText: "正在重新连接" }).waitFor();
  assert.equal(await field("service-error").isVisible(), false);
  await field("service-state").filter({ hasText: "管理服务在线" }).waitFor();
  await browserContext.unroute(snapshotURL);
  console.log("UI: one interrupted snapshot retries without an offline alert.");

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
  await until(async () => (await field("profile-password").inputValue()) === "", "Cancelled password draft was not cleared after the dialog closed");
  assert.deepEqual((await store.get("ui-regression")).encryptedPassword, originalPassword);
  console.log("UI: password save, single Enter submission, blank edit preservation and cancelled-password cleanup passed.");

  blockCleanup = true;
  await store.createBackup(); await store.createBackup();
  await field("refresh").click(); await field("storage-warning").filter({ hasText: "多余备份未能清理" }).waitFor();
  await field("open-backups").click(); await field("backup-warning").filter({ hasText: "多余备份未能清理" }).waitFor();
  assert.equal(await field("backup-error").isVisible(), false);
  blockCleanup = false; await field("create-backup").click(); await field("backup-warning").waitFor({ state: "hidden" });
  await ui.locator("#backup-dialog .dialog-actions .close-dialog").click();
  await field("refresh").click(); await field("storage-warning").waitFor({ state: "hidden" });
  console.log("UI: backup cleanup warning stays nonblocking and clears after successful cleanup.");

  const connectTool = tools.connect.execute;
  tools.connect.execute = async () => { throw Object.assign(new Error("fixture untrusted host"), { code: "HOST_KEY_REJECTED", category: "trust" }); };
  await field("connect").click(); await field("connection-guidance").filter({ hasText: "独立核对" }).waitFor();
  assert.ok((await field("connection-guidance").textContent()).includes("不要直接信任"));
  tools.connect.execute = connectTool;

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

  await field("tab-connection").click();
  await field("disconnect").click(); await field("detail-state").filter({ hasText: "未连接" }).waitFor();
  await field("edit-connection").click();
  await field("profile-name").fill("Draft survives service restart");
  const oldEndpoint = web.url;
  const oldPort = Number(new URL(oldEndpoint).port);
  await web.close();
  web = await startManagementServer({ tools, port: oldPort, recovery });
  assert.notEqual(web.url, oldEndpoint);
  const oldFrame = page.frames().find((item) => item.url().startsWith(oldEndpoint));
  assert.ok(oldFrame, "The management page should stay open during reconnection");
  await oldFrame.waitForFunction((url) => performance.getEntriesByType("resource").some((entry) => entry.name.startsWith(url + "api/snapshot")), web.url, { timeout: 15000 });
  await field("service-state").filter({ hasText: "管理服务在线" }).waitFor();
  assert.ok(oldFrame.url().startsWith(web.url), "Same-port recovery must update the document address");
  assert.equal(await field("connection-editor").evaluate((node) => node.open), true);
  assert.equal(await field("profile-name").inputValue(), "Draft survives service restart");
  await field("save-connection").click();
  await ui.locator("#connection-editor[open]").waitFor({ state: "hidden" });
  assert.equal((await store.get("ui-regression")).name, "Draft survives service restart");
  await field("tab-forwards").click();
  await field("connect").click(); await field("detail-state").filter({ hasText: "已连接" }).waitFor();
  console.log("UI: same-port token rotation reconnects without closing the editing dialog.");

  const previous = web;
  const originalBackups = tools.config_backups.execute;
  const heldBackups = hold("config_backups", originalBackups);
  await field("open-backups").click(); await until(heldBackups.entered, "The backup request was not held");
  const oldSnapshot = new URL("api/snapshot", previous.url).href;
  await browserContext.route(oldSnapshot, (route) => route.request().method() === "GET" ? route.abort("failed") : route.continue());
  web = await startManagementServer({ tools, recovery });
  await field("service-state").filter({ hasText: "管理服务正在恢复" }).waitFor({ timeout: 15000 });
  await browserContext.unroute(oldSnapshot);
  await field("refresh").evaluate((node) => node.click());
  await field("service-state").filter({ hasText: "管理服务正在恢复" }).waitFor();
  heldBackups.release();
  await field("service-state").filter({ hasText: "管理服务在线" }).waitFor({ timeout: 15000 });
  await ui.locator("#backup-dialog .dialog-actions .close-dialog").click();
  await until(() => page.frames().some((frame) => frame.url().startsWith(web.url)), "A successful old snapshot discarded the new endpoint", 15000);
  await field("service-state").filter({ hasText: "管理服务在线" }).waitFor();
  await previous.close();
  tools.config_backups.execute = originalBackups;
  console.log("UI: a successful old snapshot cannot discard a new endpoint while an operation is pending.");

  const attackerRequests = [];
  const attacker = createServer((request, response) => {
    attackerRequests.push({ path: request.url, authorization: request.headers.authorization, referrer: request.headers.referer });
    response.writeHead(200, { "Access-Control-Allow-Origin": "null", "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "fake", signature: "invalid" }));
  });
  await new Promise((resolve, reject) => { attacker.once("error", reject); attacker.listen(0, "127.0.0.1", resolve); });
  cleanup.unshift(() => new Promise((resolve) => { attacker.close(resolve); attacker.closeAllConnections(); }));
  const attackerOrigin = `http://127.0.0.1:${attacker.address().port}`;
  discoveryOverride = `@import url("${attackerOrigin}/imported.css"); :root { --migpie-management-port: ${new URL(attackerOrigin).port}; }`;
  const protectedEndpoint = web.url, protectedSnapshot = new URL("api/snapshot", protectedEndpoint).href;
  await field("tab-connection").click(); await field("disconnect").click(); await field("detail-state").filter({ hasText: "未连接" }).waitFor();
  await field("edit-connection").click(); await field("profile-name").fill("Protected draft");
  await browserContext.route(protectedSnapshot, (route) => route.request().method() === "GET" ? route.abort("failed") : route.continue());
  await until(() => attackerRequests.length > 0, "The forged discovery style was not exercised", 15000);
  assert.ok(attackerRequests.every((request) => request.path.startsWith("/recovery/identity/") && !request.authorization && !request.referrer), "Unverified services must not receive proof, token, referrer or API calls");
  assert.equal(await field("profile-name").inputValue(), "Protected draft");
  assert.equal(await field("panel-forwards").evaluate(() => document.body.dataset.attacker ?? ""), "");
  discoveryOverride = null; await browserContext.unroute(protectedSnapshot);
  await field("service-state").filter({ hasText: "管理服务在线" }).waitFor({ timeout: 15000 });
  await ui.locator("#connection-editor .dialog-actions .close-dialog").click();
  await field("tab-forwards").click(); await field("connect").click(); await field("detail-state").filter({ hasText: "已连接" }).waitFor();
  console.log("UI: a forged discovery candidate cannot receive a token or recovery proof.");

  const samePortEndpoint = web.url;
  const replacement = await startManagementServer({ tools, recovery });
  await web.close();
  const occupied = createServer((request, response) => {
    response.writeHead(404, { "Access-Control-Allow-Origin": "null", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Content-Type": "text/html" });
    response.end("<html>not the management service</html>");
  });
  await new Promise((resolve, reject) => { occupied.once("error", reject); occupied.listen(Number(new URL(samePortEndpoint).port), "127.0.0.1", resolve); });
  cleanup.unshift(() => new Promise((resolve) => { occupied.close(resolve); occupied.closeAllConnections(); }));
  web = replacement;
  await until(() => page.frames().some((frame) => frame.url().startsWith(web.url)), "The page did not navigate to the new management address", 20000);
  await field("service-state").filter({ hasText: "管理服务在线" }).waitFor();
  assert.notEqual(new URL(web.url).port, new URL(samePortEndpoint).port);
  assert.equal(sessions.status("ui-regression").state, "connected");
  await page.frames().find((frame) => frame.url().startsWith(web.url)).evaluate(() => location.reload());
  await field("service-state").filter({ hasText: "管理服务在线" }).waitFor();
  console.log("UI: an HTML response on the old port triggers authenticated recovery, navigation and a successful refresh.");
  const reloadedFrame = page.frames().find((frame) => frame.url().startsWith(web.url));
  const launchAddress = await reloadedFrame.evaluate(() => new URLSearchParams(location.hash.slice(1)).get("launcher"));
  const manual = new URL(launchAddress); manual.searchParams.set("invalid", web.url);
  await reloadedFrame.evaluate((url) => location.replace(url), manual.href);
  await until(() => page.frames().some((frame) => frame.url().startsWith(web.url)), "Manual reopening rejected a healthy unchanged service", 15000);
  await field("service-state").filter({ hasText: "管理服务在线" }).waitFor();
  console.log("UI: manually reopening accepts the same healthy management address.");

  await field("panel-forwards").evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await field("panel-forwards").evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await field("service-state").filter({ hasText: "管理服务在线" }).waitFor();
  const beforePageRestore = await field("last-updated").textContent();
  await until(async () => (await field("last-updated").textContent()) !== beforePageRestore, "Snapshot polling did not resume after restoring the cached page");
  console.log("UI: snapshot polling resumes after the browser restores a cached page.");

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

  for (const interrupted of ["frame", "identity"]) {
    const retryContext = await browser.newContext({ permissions: ["local-network-access"] });
    try {
      const retryPage = await retryContext.newPage();
      retryPage.on("pageerror", (error) => scriptErrors.push(error.message));
      let attempts = 0;
      const interruptedPath = interrupted === "frame" ? "**/recovery-frame/index.html" : "**/recovery/identity/*";
      await retryContext.route(interruptedPath, (route) => ++attempts === 1 ? route.abort("failed") : route.continue());
      await retryPage.goto(harness.url);
      const retryUI = retryPage.frameLocator('iframe[title="SSH 连接"]');
      await retryUI.locator("#service-state").filter({ hasText: "管理服务在线" }).waitFor();
      await until(() => attempts >= 2, `A failed initial recovery ${interrupted} request permanently disabled recovery`, 15000);
      const management = retryPage.frames().find((frame) => frame.url().startsWith(web.url));
      await until(async () => management.childFrames().length === 1 && management.childFrames()[0].url().endsWith("/recovery-frame/index.html"), "The replacement recovery frame did not load");
      // Wait for the identity exchange before closing its serving port.
      await management.evaluate(() => new Promise((resolve) => {
        const frame = document.querySelector("iframe");
        addEventListener("message", function receive(event) {
          if (event.source === frame.contentWindow && event.data?.type === "migpie-recovery-ready" && event.data.request === "a".repeat(43)) {
            removeEventListener("message", receive); resolve();
          }
        });
        frame.contentWindow.postMessage({ type: "migpie-recovery-challenge", request: "a".repeat(43) }, "*");
      }));
      const previous = web;
      web = await startManagementServer({ tools, recovery });
      await previous.close();
      await until(() => retryPage.frames().some((frame) => frame.url().startsWith(web.url)), `Recovery did not survive an interrupted ${interrupted} request`, 20000);
      await retryUI.locator("#service-state").filter({ hasText: "管理服务在线" }).waitFor();
    } finally { await retryContext.close(); }
  }
  console.log("UI: interrupted initial recovery frame and identity requests retry while online and recover across ports.");

  const spoofed = await browser.newContext({ permissions: ["local-network-access"] });
  const spoofedPage = await spoofed.newPage(), leaked = [];
  await spoofedPage.exposeFunction("recordSpoof", (value) => leaked.push(value));
  await spoofedPage.addInitScript(() => addEventListener("message", (event) => { if (event.data?.type === "fixture-spoof") window.recordSpoof(JSON.stringify(event.data.data)); }));
  const genuine = new URL("/recovery-frame/index.html", web.url).href;
  await spoofed.route(genuine, (route) => route.fulfill({ status: 200, contentType: "text/html", body: `<script>addEventListener('message', e => parent.postMessage({type:'fixture-spoof', data:e.data}, '*'))</script>` }));
  await spoofedPage.goto(harness.url);
  const spoofedUI = spoofedPage.frameLocator('iframe[title="SSH 连接"]');
  await spoofedUI.locator("#service-state").filter({ hasText: "管理服务在线" }).waitFor();
  await until(() => leaked.length > 0, "The spoofed frame did not receive its identity challenge");
  await spoofed.route(new URL("api/snapshot", web.url).href, (route) => route.abort("failed"));
  await spoofedUI.locator("#service-state").filter({ hasText: "管理服务离线" }).waitFor({ timeout: 15000 });
  await spoofedPage.waitForTimeout(5500);
  assert.ok(leaked.every((value) => !value.includes("launcher") && !value.includes(recovery.secret) && !value.includes(web.token)), "An unauthenticated frame must not receive the launcher or recovery credentials");
  await spoofed.close();
  assert.deepEqual(scriptErrors, [], "Browser script errors");
  console.log(`UI: sandboxed desktop/narrow layout and browser script errors passed. Screenshots: ${screenshotDirectory}`);
} finally {
  for (const release of releaseRequests) release();
  for (const fn of cleanup) await fn();
}
