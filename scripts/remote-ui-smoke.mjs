import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { ProfileStore } from "../src/store.mjs";
import { SessionManager } from "../src/sessions.mjs";
import { RemoteManager } from "../src/remote.mjs";
import { probeScript } from "../src/remote-scripts.mjs";
import { createTools } from "../src/plugin.mjs";
import { startManagementServer } from "../src/web-server.mjs";
import { sshServer, temporary, until } from "../tests/helpers.mjs";
import { startUIHarness } from "./ui-harness.mjs";

// Every SSH exec is answered by this fixture. Received scripts are inspected as
// text only: no deployment command, download, service or real Magpie is run.
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function remoteFixture(context) {
  const fixture = await sshServer(context);
  const state = {
    platform: "Linux", architecture: "x86_64", container: false,
    installed: false, systemd: true, serviceInstalled: false,
    serviceActive: "inactive", webEnabled: false, webTLS: false,
    version: "0.1.1472", locked: false, reconcile: "", nextUnknown: false,
  };
  const executions = [];
  let actionGate = null;
  function probe() {
    const values = {
      ...state, username: "tester", home: "/home/tester",
      binary: state.installed ? "/home/tester/.local/bin/magpie" : "",
      managedBinary: "/home/tester/.local/bin/magpie", binaryHash: state.installed ? "a".repeat(64) : "",
      configDirectory: "/home/tester/.config/magpie", unit: "/home/tester/.config/systemd/user/magpie.service",
      unitHash: state.serviceInstalled ? "b".repeat(64) : "", webPort: "3430", linger: "yes",
      tools: "curl sha256sum base64 mktemp install readlink",
    };
    return "MIGPIE_REMOTE_V1\n" + Object.entries(values).map(([key, value]) => key + "\t" + Buffer.from(String(value)).toString("base64")).join("\n") + "\n";
  }
  fixture.server.on("connection", (client) => {
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept(); session.on("error", () => {});
      session.on("exec", (acceptExec, _reject, { command }) => {
        const channel = acceptExec(); channel.on("error", () => {});
        let input = "";
        channel.on("data", (chunk) => { input += chunk.toString(); });
        channel.on("end", () => { void (async () => {
          const finish = (stdout, code = 0) => { channel.write(stdout); channel.exit(code); channel.end(); };
          if (command === "sh -s" && input === probeScript) {
            executions.push({ kind: "probe" }); finish(probe()); return;
          }
          if (command === "sh -s" && input.includes("cat \"$base/operations/")) {
            executions.push({ kind: "reconcile" }); finish(state.reconcile + "\n"); return;
          }
          if (command.endsWith(" daemon web")) {
            executions.push({ kind: "web" }); finish("http://127.0.0.1:3430/?k=fixture-management-key-1234567890\n"); return;
          }
          const script = command === "sh -s" ? input : command;
          let action;
          if (script.includes("download.XXXXXXXX")) action = "install";
          else if (script.includes("config.magpie")) action = "update";
          else if (script.includes("daemon install --web")) action = "enable_web";
          else if (script.includes("daemon restart")) action = "restart";
          else if (script.includes("daemon start")) action = "start";
          else if (script.includes("daemon stop")) action = "stop";
          else if (script.includes("expected=\"$HOME/.local/bin/magpie\"")) action = "uninstall";
          assert.ok(action, "Fixture rejected an unexpected exec request");
          executions.push({ kind: "action", action, ...(action === "update" && { passphrase: input }) });
          const gate = actionGate; actionGate = null;
          if (gate) await gate.promise;
          if (action === "install") state.installed = true;
          if (action === "enable_web") { state.serviceInstalled = true; state.webEnabled = true; state.serviceActive = "active"; }
          if (["start", "restart"].includes(action)) state.serviceActive = "active";
          if (action === "stop") state.serviceActive = "inactive";
          if (action === "uninstall") { state.installed = false; state.serviceInstalled = false; state.webEnabled = false; }
          if (state.nextUnknown) { state.nextUnknown = false; finish("fixture-response-without-completion-marker\n"); return; }
          finish("MIGPIE_DONE\n");
        })().catch(() => { channel.exit(70); channel.end(); }); });
      });
    }));
  });
  return { ...fixture, state, executions, holdAction() { const gate = deferred(); actionGate = gate; return gate; } };
}

const cleanup = [], releases = [];
const context = { after(fn) { cleanup.unshift(fn); } };
try {
  const directory = await temporary(context), fixture = await remoteFixture(context);
  const store = new ProfileStore(join(directory, "connections.json"));
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  cleanup.unshift(() => sessions.close());
  const remote = new RemoteManager({ store, sessions, release: async () => ({ version: "0.1.1472", sha256: "a".repeat(64), url: "https://github.com/yetone/magpie-releases/releases/download/test/magpie-cli-linux-amd64" }) });
  cleanup.unshift(() => remote.close());
  const tools = createTools(store, sessions, remote);
  for (const [id, name] of [["remote-alpha", "生产服务器"], ["remote-beta", "测试服务器"]]) {
    await tools.save_connection.execute({ connection: { ...fixture.profile, id, name } });
    await tools.connect.execute({ connectionId: id });
  }
  const web = await startManagementServer({ tools }); cleanup.unshift(() => web.close());
  const harness = await startUIHarness({ getEndpoint: () => web.url }); cleanup.unshift(() => harness.close());
  const executable = process.env.MIGPIE_UI_BROWSER;
  const options = executable ? { executablePath: resolve(executable) } : !existsSync(chromium.executablePath()) && process.platform === "win32" ? { channel: "msedge" } : {};
  const browser = await chromium.launch({ ...options, headless: true }); cleanup.unshift(() => browser.close());
  const browserContext = await browser.newContext({ viewport: { width: 1280, height: 1000 }, permissions: ["local-network-access"] });
  const page = await browserContext.newPage(), errors = [], counts = new Map();
  page.on("pageerror", (error) => errors.push(error.message));
  const api = new URL("api/call", web.url).href;
  page.on("request", (request) => {
    if (request.url() !== api || request.method() !== "POST") return;
    const { method } = request.postDataJSON(); counts.set(method, (counts.get(method) ?? 0) + 1);
  });
  const ui = page.frameLocator('iframe[title="SSH 连接"]');
  const field = (id) => ui.locator("#" + id);
  const selectedRow = (name) => ui.locator(".connection-card").filter({ hasText: name });
  const count = (method) => counts.get(method) ?? 0;
  const waitEnabled = (id) => until(() => field(id).isEnabled(), id + " stayed disabled");
  const detect = async () => { await waitEnabled("remote-detect"); await field("remote-detect").click(); await waitEnabled("remote-detect"); };
  const preview = async (action) => {
    await waitEnabled("remote-action-" + action); await field("remote-action-" + action).click();
    await until(async () => (await ui.locator("#remote-preview-changes li").count()) > 0, "Missing action preview");
  };
  const closePreview = () => ui.locator("#remote-preview .dialog-actions .remote-close-preview").click();
  const gateTool = (name) => {
    const execute = tools[name].execute, entered = deferred(), release = deferred(); releases.push(release.resolve);
    tools[name].execute = async (...args) => { const result = await execute(...args); entered.resolve(); await release.promise; return result; };
    return { entered: entered.promise, release() { tools[name].execute = execute; release.resolve(); } };
  };
  const openRemote = async () => { await field("tab-remote").click(); await field("panel-remote").waitFor(); };
  const showWeb = async () => { await waitEnabled("remote-open-web"); await field("remote-open-web").click(); await field("remote-web-result").waitFor(); };

  await page.goto(harness.url); await field("service-state").filter({ hasText: "管理服务在线" }).waitFor();
  assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts");
  assert.equal(count("remote_status"), 0);
  await openRemote(); assert.equal(await field("remote-action-install").isDisabled(), true);
  await detect(); await waitEnabled("remote-action-install");
  assert.equal(await field("remote-action-update").isDisabled(), true);
  await preview("install");
  const installGate = fixture.holdAction(); releases.push(installGate.resolve);
  const applyBefore = count("remote_apply");
  await field("remote-apply").evaluate((node) => { node.click(); node.click(); });
  await ui.locator("#remote-preview[open]").waitFor({ state: "hidden" });
  await field("remote-operation-state").filter({ hasText: "执行中" }).waitFor();
  assert.equal(count("remote_apply"), applyBefore + 1);
  assert.equal(await field("remote-detect").isDisabled(), true, "Forced detection must not issue REMOTE_BUSY during execution");
  await page.reload(); await field("service-state").filter({ hasText: "管理服务在线" }).waitFor(); await openRemote();
  await field("remote-operation-state").filter({ hasText: "执行中" }).waitFor();
  installGate.resolve(); await field("remote-operation-state").filter({ hasText: "已完成" }).waitFor();
  await field("remote-install-state").filter({ hasText: "已安装" }).waitFor();
  assert.equal(fixture.executions.filter((item) => item.action === "install").length, 1);
  console.log("Remote UI: explicit detection, real preview/apply HTTP, single submission and background task restoration passed.");

  await preview("update"); await field("remote-backup-passphrase").fill("short");
  assert.equal(await field("remote-apply").isDisabled(), true);
  const secret = "fixture-update-passphrase";
  await field("remote-backup-passphrase").fill(secret); await field("remote-show-passphrase").click();
  assert.equal(await field("remote-backup-passphrase").getAttribute("type"), "text");
  await field("remote-backup-passphrase").focus(); await page.waitForTimeout(2200);
  assert.equal(await field("remote-backup-passphrase").inputValue(), secret);
  assert.equal(await field("remote-backup-passphrase").evaluate((node) => node === document.activeElement), true);
  const updateGate = fixture.holdAction(); releases.push(updateGate.resolve);
  const heldApply = gateTool("remote_apply");
  await field("remote-backup-passphrase").press("Enter"); await heldApply.entered;
  assert.equal(await field("remote-backup-passphrase").inputValue(), "");
  assert.equal(await field("remote-apply").isDisabled(), true); await closePreview();
  assert.equal(await field("remote-preview").evaluate((node) => node.open), false);
  heldApply.release(); updateGate.resolve();
  await field("remote-operation-state").filter({ hasText: "已完成" }).waitFor();
  await until(() => fixture.executions.some((item) => item.action === "update"));
  assert.equal(fixture.executions.find((item) => item.action === "update").passphrase, secret + "\n");
  assert.ok(!(await readFile(remote.file, "utf8")).includes(secret));
  console.log("Remote UI: update passphrase validation, visibility, retained focus, stdin delivery, clearing and close-during-submit passed.");

  fixture.state.nextUnknown = true; await preview("update"); await field("remote-backup-passphrase").fill(secret); await field("remote-apply").click();
  await field("remote-operation-state").filter({ hasText: "结果未知" }).waitFor();
  await detect(); assert.equal(await field("remote-action-update").isDisabled(), true);
  assert.equal((await remote.operation("remote-alpha")).state, "unknown");
  fixture.state.reconcile = "succeeded"; await detect(); await field("remote-operation-state").filter({ hasText: "已完成" }).waitFor();
  await waitEnabled("remote-action-update");
  console.log("Remote UI: unknown stays locked after a probe and only explicit remote completion records restore actions.");

  fixture.state.container = true; await detect();
  assert.equal(await field("remote-action-update").isDisabled(), true); assert.match(await field("remote-action-hint").textContent(), /容器/);
  fixture.state.container = false; fixture.state.systemd = false; await detect();
  assert.equal(await field("remote-action-update").isDisabled(), false); assert.equal(await field("remote-action-uninstall").isDisabled(), false);
  for (const action of ["start", "stop", "restart", "enable_web"]) assert.equal(await field("remote-action-" + action).isDisabled(), true);
  fixture.state.serviceInstalled = true; await detect(); assert.equal(await field("remote-action-update").isDisabled(), true);
  fixture.state.systemd = true; fixture.state.serviceActive = "activating"; await detect(); assert.equal(await field("remote-action-update").isDisabled(), true);
  fixture.state.serviceActive = "inactive"; fixture.state.serviceInstalled = false; fixture.state.webTLS = true; await detect();
  assert.equal(await field("remote-action-enable_web").isDisabled(), true); assert.equal(await field("remote-open-web").isDisabled(), true);
  fixture.state.webTLS = false; fixture.state.platform = "Darwin"; await detect(); assert.equal(await field("remote-action-update").isDisabled(), true);
  fixture.state.platform = "Linux"; await detect();
  await preview("enable_web"); await field("remote-apply").click();
  await field("remote-operation-state").filter({ hasText: "已完成" }).waitFor(); await waitEnabled("remote-open-web");
  console.log("Remote UI: platform, container, existing service/systemd, unknown service and TLS capability checks passed.");

  const webBefore = count("remote_web"); await field("remote-web-port").fill("4444"); await field("remote-web-port").focus();
  await page.waitForTimeout(2200); assert.equal(await field("remote-web-port").inputValue(), "4444");
  assert.equal(await field("remote-web-port").evaluate((node) => node === document.activeElement), true);
  assert.equal(count("remote_web"), webBefore);
  await field("remote-web-port").fill("3430"); await showWeb();
  assert.match(await field("remote-web-url").inputValue(), /fixture-management-key/);
  assert.ok(!(await field("toast").textContent()).includes("fixture-management-key"));
  const heldWeb = gateTool("remote_web");
  await field("remote-open-web").click(); await heldWeb.entered;
  await selectedRow("测试服务器").click(); await openRemote(); heldWeb.release();
  await page.waitForTimeout(150); assert.equal(await field("remote-web-url").inputValue(), "");
  await detect(); await showWeb();
  await field("disconnect").click(); await field("detail-state").filter({ hasText: "未连接" }).waitFor();
  assert.equal(await field("remote-web-url").inputValue(), ""); assert.equal(await field("remote-action-update").isDisabled(), true);
  await field("connect").click(); await field("detail-state").filter({ hasText: "已连接" }).waitFor(); await detect(); await showWeb();
  await field("panel-remote").evaluate(() => dispatchEvent(new Event("pagehide")));
  assert.equal(await field("remote-web-url").inputValue(), ""); assert.equal(await field("remote-backup-passphrase").inputValue(), "");
  await page.reload(); await field("service-state").filter({ hasText: "管理服务在线" }).waitFor(); await openRemote();
  console.log("Remote UI: explicit Web access, editable port, retained focus and late-response/switch/disconnect/pagehide key cleanup passed.");

  const heldPreview = gateTool("remote_preview");
  await field("remote-action-update").click(); await heldPreview.entered;
  await closePreview(); await selectedRow("测试服务器").click(); await openRemote(); heldPreview.release();
  await page.waitForTimeout(150); assert.equal(await field("remote-preview").evaluate((node) => node.open), false);
  assert.equal(await field("remote-backup-passphrase").inputValue(), "");
  await preview("restart");
  const heldCrossApply = gateTool("remote_apply"), crossAction = fixture.holdAction(); releases.push(crossAction.resolve);
  await field("remote-apply").click(); await heldCrossApply.entered; await closePreview();
  await selectedRow("生产服务器").click(); await openRemote();
  await field("remote-operation-time").filter({ hasText: (await remote.operation("remote-alpha")).id }).waitFor();
  const originalOperation = await field("remote-operation-time").textContent();
  heldCrossApply.release(); crossAction.resolve(); await page.waitForTimeout(150);
  assert.equal(await field("remote-operation-time").textContent(), originalOperation);
  await field("tab-forwards").click(); await page.waitForTimeout(150);
  const inactiveCount = count("remote_status"); await page.waitForTimeout(2200); assert.equal(count("remote_status"), inactiveCount);
  await field("tab-forwards").press("ArrowRight"); assert.equal(await field("tab-remote").getAttribute("aria-selected"), "true");
  await field("tab-remote").press("End"); assert.equal(await field("tab-logs").getAttribute("aria-selected"), "true");
  await openRemote();
  console.log("Remote UI: late preview/apply responses stay with their connection; inactive polling and keyboard navigation passed.");

  await browserContext.route(api, async (route) => {
    if (route.request().postDataJSON()?.method === "remote_apply") await route.abort("failed");
    else await route.continue();
  });
  await preview("restart"); await field("remote-apply").click();
  await field("remote-preview-error").filter({ hasText: "提交结果待核实" }).waitFor(); await closePreview();
  await detect();
  assert.equal(await field("remote-action-restart").isDisabled(), true, "An older completed operation must not resolve a lost submission response");
  await browserContext.unroute(api);
  await page.reload(); await field("service-state").filter({ hasText: "管理服务在线" }).waitFor(); await openRemote();
  console.log("Remote UI: a lost apply response cannot be cleared by an unrelated completed operation.");

  const screenshots = resolve(process.env.MIGPIE_REMOTE_UI_ARTIFACTS ?? ".local/remote-ui-regression"); await mkdir(screenshots, { recursive: true });
  await field("connection-detail").evaluate((node) => { node.scrollTop = 220; });
  await page.screenshot({ path: join(screenshots, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 555, height: 900 });
  await field("toggle-list").waitFor();
  await field("toggle-list").evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  if (await field("toggle-list").getAttribute("aria-expanded") === "true") await field("toggle-list").click();
  await until(() => field("remote-install-state").isVisible(), "Narrow layout did not expose remote management");
  await field("connection-detail").evaluate((node) => { node.scrollTop = 240; });
  const layout = await field("panel-remote").evaluate(() => ({ viewport: innerWidth, body: document.documentElement.scrollWidth, detail: document.getElementById("connection-detail").clientWidth, scroll: document.getElementById("connection-detail").scrollWidth }));
  assert.equal(layout.viewport, 390); assert.ok(layout.body <= layout.viewport + 1); assert.ok(layout.scroll <= layout.detail + 1);
  await page.screenshot({ path: join(screenshots, "narrow-390.png"), fullPage: true });
  await preview("update");
  assert.equal(await field("remote-preview").evaluate((node) => node.scrollWidth > node.clientWidth + 1), false);
  await page.screenshot({ path: join(screenshots, "preview-390.png"), fullPage: true }); await closePreview();
  assert.ok((await stat(join(screenshots, "desktop.png"))).size > 1000);
  assert.deepEqual(errors, [], "Browser script errors");
  console.log(`Remote UI: 390px iframe and preview layout passed. Screenshots: ${screenshots}`);
} finally {
  for (const release of releases) release();
  for (const fn of cleanup) await fn();
}
