import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { ProfileStore } from "../src/store.mjs";
import { SessionManager } from "../src/sessions.mjs";
import { RemoteManager } from "../src/remote.mjs";
import { probeScript } from "../src/remote-scripts.mjs";
import { backupInventoryScript } from "../src/remote-backups.mjs";
import { createTools } from "../src/plugin.mjs";
import { startManagementServer, loadRecoveryKey } from "../src/web-server.mjs";
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
    version: "0.1.1327", locked: false, reconcile: "", nextUnknown: false, nextFailure: null, backups: [],
    capabilities: "update backup restore healthcheck daemon_install daemon_uninstall daemon_start daemon_stop daemon_restart daemon_web daemon_install_web",
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
      tools: "curl sha256sum base64 mktemp install readlink tar",
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
          if (command === "sh -s" && input === backupInventoryScript) {
            executions.push({ kind: "backups" });
            finish("MIGPIE_BACKUPS_V1\n" + state.backups.map((backup) => [backup.id, backup.format, 1234, true, 1760000000, Buffer.from("magpie " + state.version).toString("base64"), "f".repeat(64)].join("\t")).join("\n") + (state.backups.length ? "\n" : "")); return;
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
          else if (script.includes("set_step deleting_backup")) action = "delete_backup";
          else if (script.includes("run_step restoring")) action = "restore";
          else if (script.includes('"$bin" update')) action = "update";
          else if (script.includes("config.magpie") || script.includes("config.tar.gz")) action = "backup";
          else if (script.includes("daemon install --web")) action = "enable_web";
          else if (script.includes("daemon restart")) action = "restart";
          else if (script.includes("daemon start")) action = "start";
          else if (script.includes("daemon stop")) action = "stop";
          else if (script.includes("expected=\"$HOME/.local/bin/magpie\"")) action = "uninstall";
          assert.ok(action, "Fixture rejected an unexpected exec request");
          executions.push({ kind: "action", action, command, script });
          const gate = actionGate; actionGate = null;
          if (gate) {
            gate.entered.resolve({ channel, operationId: script.match(/operations\/([a-f0-9-]{36})/)?.[1] });
            await gate.promise;
          }
          if (state.nextFailure) {
            const { step, reason, backupReady } = state.nextFailure; state.nextFailure = null;
            const operationId = script.match(/operations\/([a-f0-9-]{36})/)?.[1];
            assert.ok(operationId);
            finish(`MIGPIE_RESULT_V1\t${operationId}\t${step}\t1\t${reason}\t${backupReady}\n`, 1); return;
          }
          if (["update", "backup", "restore"].includes(action)) state.backups.push({ id: script.match(/operations\/([a-f0-9-]{36})/)?.[1], format: "archive" });
          if (action === "delete_backup") {
            const selected = script.match(/backup="\$root\/([a-f0-9-]{36})"/)?.[1];
            state.backups = state.backups.filter((backup) => backup.id !== selected);
          }
          if (action === "install") state.installed = true;
          if (action === "enable_web") { state.serviceInstalled = true; state.webEnabled = true; state.serviceActive = "active"; }
          if (["start", "restart"].includes(action)) state.serviceActive = "active";
          if (action === "stop") state.serviceActive = "inactive";
          if (action === "uninstall") { state.installed = false; state.serviceInstalled = false; state.webEnabled = false; }
          if (state.nextUnknown) { state.nextUnknown = false; finish("fixture-response-without-completion-marker\n"); return; }
          if (action === "restore") {
            const operationId = script.match(/operations\/([a-f0-9-]{36})/)?.[1];
            const recovery = Buffer.from("/home/tester/.config/magpie-remote/backups/" + operationId).toString("base64");
            finish(`MIGPIE_DONE\nMIGPIE_RESULT_V1\t${operationId}\tcompleted\t0\tnone\ttrue\nMIGPIE_RESTORE_V1\t${operationId}\tapplied\trunning\tnot_needed\t${recovery}\n`); return;
          }
          finish("MIGPIE_DONE\n");
        })().catch(() => { channel.exit(70); channel.end(); }); });
      });
    }));
  });
  return { ...fixture, state, executions, holdAction() {
    const gate = { ...deferred(), entered: deferred() };
    actionGate = gate;
    return { ...gate, async progress(step, downloadedBytes, totalBytes = 0) {
      const { channel, operationId } = await gate.entered.promise;
      assert.ok(operationId, "Progress requires the current operation UUID");
      const marker = `MIGPIE_PROGRESS_V1\t${operationId}\t${step}\t${downloadedBytes}\t${totalBytes}\n`;
      channel.write(marker.slice(0, 10));
      await delay(20);
      channel.write(marker.slice(10, marker.length - 2));
      await delay(20);
      channel.write(marker.slice(-2));
    } };
  } };
}

const cleanup = [], releases = [];
const context = { after(fn) { cleanup.unshift(fn); } };
try {
  const directory = await temporary(context), fixture = await remoteFixture(context);
  const releasedVersion = "0.1.1472";
  const store = new ProfileStore(join(directory, "connections.json"));
  const sessions = new SessionManager({ env: { MIGPIE_TEST_PASSWORD: "local-test-secret" } });
  cleanup.unshift(() => sessions.close());
  const remote = new RemoteManager({ store, sessions, release: async () => ({ version: releasedVersion, sha256: "a".repeat(64), url: "https://github.com/yetone/magpie-releases/releases/download/test/magpie-cli-linux-amd64" }) });
  cleanup.unshift(() => remote.close());
  const tools = createTools(store, sessions, remote);
  for (const [id, name] of [["remote-alpha", "生产服务器"], ["remote-beta", "测试服务器"]]) {
    await tools.save_connection.execute({ connection: { ...fixture.profile, id, name } });
    await tools.connect.execute({ connectionId: id });
  }
  const recovery = await loadRecoveryKey(join(directory, "recovery.key"));
  let web = await startManagementServer({ tools, recovery }); cleanup.unshift(() => web.close());
  const harness = await startUIHarness({ getEndpoint: () => web.url, recovery }); cleanup.unshift(() => harness.close());
  const executable = process.env.MIGPIE_UI_BROWSER;
  const options = executable ? { executablePath: resolve(executable) } : !existsSync(chromium.executablePath()) && process.platform === "win32" ? { channel: "msedge" } : {};
  const browser = await chromium.launch({ ...options, headless: true }); cleanup.unshift(() => browser.close());
  const browserContext = await browser.newContext({ viewport: { width: 1280, height: 1000 }, permissions: ["local-network-access"] });
  const page = await browserContext.newPage(), errors = [], counts = new Map(), requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const api = new URL("api/call", web.url).href;
  page.on("request", (request) => {
    if (request.url() !== api || request.method() !== "POST") return;
    const body = request.postDataJSON(); requests.push(body);
    counts.set(body.method, (counts.get(body.method) ?? 0) + 1);
  });
  const ui = page.frameLocator('iframe[title="SSH 连接"]');
  const field = (id) => ui.locator("#" + id);
  const selectedRow = (name) => ui.locator(".connection-card").filter({ hasText: name });
  const count = (method) => counts.get(method) ?? 0;
  const waitEnabled = (id) => until(() => field(id).isEnabled(), id + " stayed disabled");
  const waitOperation = (value) => until(async () => (await field("remote-task-state").textContent()).includes(value), "Remote operation did not become " + value);
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
  await waitOperation("执行中");
  assert.equal(count("remote_apply"), applyBefore + 1);
  assert.equal(await field("remote-detect").isDisabled(), true, "Forced detection must not issue REMOTE_BUSY during execution");
  await installGate.progress("downloading", 1048576, 4194304);
  await delay(320);
  await installGate.progress("downloading", 2097152, 4194304);
  await waitOperation("已下载 2 MB / 4 MB（50%）");
  assert.match(await field("remote-task-state").textContent(), /下载程序.*[\d.,]+ [KM]?B\/s/);
  assert.ok(!(await field("remote-task-state").textContent()).includes("· 0 B/s"), "A measured download must display nonzero speed");
  assert.ok((await remote.operation("remote-alpha")).progress.bytesPerSecond > 0);
  assert.equal(await field("remote-task-summary").evaluate((node) => Boolean(node.compareDocumentPosition(document.getElementById("remote-action-install")) & Node.DOCUMENT_POSITION_FOLLOWING)), true, "Task summary must precede program actions");
  const heldProgressStatus = gateTool("remote_status"); await heldProgressStatus.entered;
  await selectedRow("测试服务器").click(); await openRemote(); heldProgressStatus.release();
  await page.waitForTimeout(150);
  assert.ok(!(await field("remote-task-state").textContent()).includes("已下载"), "Late progress responses must stay with their connection");
  await selectedRow("生产服务器").click(); await openRemote(); await waitOperation("已下载 2 MB / 4 MB（50%）");
  await page.reload(); await field("service-state").filter({ hasText: "管理服务在线" }).waitFor(); await openRemote();
  await waitOperation("已下载 2 MB / 4 MB（50%）");
  assert.equal(await field("remote-operation").count(), 0);
  installGate.resolve(); await waitOperation("已完成");
  assert.ok(!(await field("remote-task-state").textContent()).includes("已下载"));
  await field("remote-install-state").filter({ hasText: "已安装" }).waitFor();
  assert.equal(fixture.executions.filter((item) => item.action === "install").length, 1);
  console.log("Remote UI: explicit detection, one submission, fragmented SSH download bytes/speed/percentage, reload and late connection response handling passed.");

  fixture.state.version = releasedVersion; await detect();
  assert.equal(await field("remote-action-update").isVisible(), false);
  assert.match(await field("remote-update-state").textContent(), /最新版/);
  fixture.state.version = "0.1.1327"; await detect();
  assert.equal(await field("remote-action-update").isVisible(), true);
  await preview("update");
  assert.equal(await field("remote-backup-passphrase").count(), 0);
  assert.ok((await field("remote-preview-warnings").textContent()).includes("未加密"));
  await waitEnabled("remote-apply");
  const updateGate = fixture.holdAction(); releases.push(updateGate.resolve);
  const heldApply = gateTool("remote_apply");
  await field("remote-apply").evaluate((node) => { node.click(); node.click(); }); await heldApply.entered;
  assert.equal(await field("remote-apply").isDisabled(), true); await closePreview();
  assert.equal(await field("remote-preview").evaluate((node) => node.open), false);
  heldApply.release();
  await updateGate.progress("updating", 5242880);
  await delay(320);
  await updateGate.progress("updating", 10485760);
  await waitOperation("已下载 10 MB");
  const updateProgress = await field("remote-task-state").textContent();
  assert.match(updateProgress, /执行官方更新.*已下载 10 MB · [\d.,]+ [KM]?B\/s/);
  assert.ok(!updateProgress.includes("%"), "An unknown total must not invent a percentage");
  assert.ok(!updateProgress.includes("· 0 B/s"), "Measured update speed must reach the summary");
  assert.ok((await remote.operation("remote-alpha")).progress.bytesPerSecond > 0);
  await updateGate.progress("restarting", 0);
  await waitOperation("重启用户服务");
  assert.ok(!(await field("remote-task-state").textContent()).includes("已下载"), "Changing stage must clear active download text");
  updateGate.resolve();
  await waitOperation("已完成");
  assert.ok(!(await field("remote-task-state").textContent()).includes("已下载"));
  await until(() => fixture.executions.some((item) => item.action === "update"));
  const updateExecution = fixture.executions.find((item) => item.action === "update");
  assert.equal(updateExecution.command, "sh -s");
  assert.ok(updateExecution.script.includes("tar -czf"));
  assert.ok(!updateExecution.script.includes('"$bin" backup'));
  assert.ok(requests.filter((item) => item.method === "remote_apply").every((item) => !Object.hasOwn(item, "credentials")));
  console.log("Remote UI: archive preview without credentials, measured update bytes/speed without a fabricated percentage, stage cleanup and close-during-submit passed.");

  fixture.state.nextFailure = { step: "updating", reason: "network", backupReady: true };
  await preview("update");
  const failedDownload = fixture.holdAction(); releases.push(failedDownload.resolve);
  await field("remote-apply").click();
  await failedDownload.progress("updating", 3145728);
  await delay(320);
  await failedDownload.progress("updating", 6291456);
  await waitOperation("已下载 6 MB");
  failedDownload.resolve(); await waitOperation("失败");
  assert.ok(!(await field("remote-task-state").textContent()).includes("已下载"), "Failed downloads must not keep active progress");
  const failedOperation = await remote.operation("remote-alpha");
  const failureLog = () => ui.locator("#log-list .log-message").filter({ hasText: "执行官方更新失败" });
  await field("remote-view-logs").click();
  await failureLog().waitFor();
  assert.equal(await field("remote-operation").count(), 0, "Runtime logs must have no duplicate task detail panel");
  assert.equal(await failureLog().count(), 1);
  assert.match(await failureLog().textContent(), /网络、代理或证书/);
  assert.ok((await failureLog().textContent()).includes(failedOperation.result.backupDirectory));
  await page.reload(); await field("service-state").filter({ hasText: "管理服务在线" }).waitFor(); await openRemote();
  await waitOperation("失败"); await field("tab-logs").click(); await failureLog().waitFor();
  await field("history-filter").selectOption("failed");
  await ui.locator("#operation-history-list article").filter({ hasText: failedOperation.id }).waitFor();
  assert.equal(await ui.locator("#operation-history-list article").count(), 1);
  await field("history-filter").selectOption("all");
  assert.ok(await ui.locator("#operation-history-list article").count() > 1);
  const heldHistory = gateTool("remote_status"); await heldHistory.entered;
  await selectedRow("测试服务器").click(); await field("tab-logs").click(); heldHistory.release();
  await page.waitForTimeout(150);
  assert.ok(!(await field("operation-history-list").textContent()).includes(failedOperation.id));
  await selectedRow("生产服务器").click(); await field("tab-logs").click();
  await ui.locator("#operation-history-list article").filter({ hasText: failedOperation.id }).waitFor();
  assert.equal(await failureLog().count(), 1);
  assert.ok((await failureLog().textContent()).includes(failedOperation.result.backupDirectory));
  const failureScreenshots = resolve(process.env.MIGPIE_REMOTE_UI_ARTIFACTS ?? ".local/remote-ui-regression"); await mkdir(failureScreenshots, { recursive: true });
  await field("log-list").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(failureScreenshots, "update-failure.png"), fullPage: true });
  console.log("Remote UI: classified update failure and backup path appear once in shared logs and survive page reload.");

  await openRemote();
  fixture.state.nextUnknown = true; await preview("update");
  const unknownDownload = fixture.holdAction(); releases.push(unknownDownload.resolve);
  await field("remote-apply").click(); await unknownDownload.progress("updating", 7340032);
  await waitOperation("已下载 7 MB");
  unknownDownload.resolve(); await waitOperation("结果未知");
  assert.ok(!(await field("remote-task-state").textContent()).includes("已下载"), "Unknown results must not keep active progress");
  await detect(); assert.equal(await field("remote-action-update").isDisabled(), true);
  assert.equal((await remote.operation("remote-alpha")).state, "unknown");
  fixture.state.reconcile = "succeeded"; await detect(); await waitOperation("已完成");
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
  assert.equal(await field("remote-action-start").isDisabled(), true);
  assert.match(await field("remote-service-hint").textContent(), /请先点击「启用 Web」/);
  assert.equal(await field("remote-action-enable_web").isEnabled(), true);
  await preview("enable_web"); await field("remote-apply").click();
  await waitOperation("已完成"); await waitEnabled("remote-open-web");
  console.log("Remote UI: legacy 0.1.1327 can enable its first service; platform, container, systemd, service and TLS checks passed.");

  const capabilities = fixture.state.capabilities;
  fixture.state.capabilities = capabilities.replace("backup ", ""); await detect();
  await preview("update");
  assert.equal(await field("remote-passphrase-field").count(), 0);
  assert.ok((await field("remote-preview-warnings").textContent()).includes("未加密"));
  await waitEnabled("remote-apply");
  await field("remote-apply").click();
  await ui.locator("#remote-preview[open]").waitFor({ state: "hidden" });
  await waitOperation("已完成");
  await until(() => fixture.executions.filter((item) => item.action === "update").at(-1)?.script.includes("config.tar.gz"), "Archive update was not dispatched");
  fixture.state.capabilities = capabilities.replace("update ", ""); await detect();
  assert.equal(await field("remote-action-update").isDisabled(), true);
  assert.match(await field("remote-update-detail").textContent(), /magpie update/);
  assert.equal(await field("remote-action-stop").isEnabled(), true);
  fixture.state.capabilities = capabilities; await detect();
  console.log("Remote UI: legacy archive backup preview, no passphrase submission and action-specific capability reasons passed.");

  await field("remote-refresh-backups").click();
  await until(async () => (await ui.locator("#remote-backup-list [data-backup-id]").count()) > 0, "Backup inventory stayed empty");
  const beforeBackup = fixture.state.backups.length;
  const updatesBeforeBackup = fixture.executions.filter((item) => item.action === "update").length;
  await preview("backup");
  assert.equal(requests.filter((item) => item.method === "remote_preview").at(-1).args.action, "backup");
  assert.equal(await field("remote-preview-summary").textContent(), "创建备份");
  await field("remote-apply").click(); await waitOperation("已完成");
  assert.equal(requests.filter((item) => item.method === "remote_apply").at(-1).args.action, "backup");
  assert.match(await field("remote-task-state").textContent(), /创建备份：已完成/);
  await until(() => fixture.state.backups.length > beforeBackup);
  assert.equal(fixture.executions.filter((item) => item.action === "update").length, updatesBeforeBackup);
  await field("remote-refresh-backups").click();
  const selectedBackup = fixture.state.backups.find((backup) => backup.format === "archive");
  const backupAction = (action) => ui.locator(`#remote-backup-list [data-action="${action}"][data-backup-id="${selectedBackup.id}"]`);
  await backupAction("restore").waitFor(); await backupAction("restore").click();
  await waitEnabled("remote-apply");
  assert.equal(await field("remote-backup-passphrase").count(), 0);
  await field("remote-apply").click(); await waitOperation("已完成");
  await until(() => fixture.executions.some((item) => item.action === "restore"));
  await field("tab-logs").click();
  await ui.locator("#operation-history-list article").filter({ hasText: "配置已应用；服务已启动并通过健康检查" }).waitFor();
  assert.equal((await remote.operation("remote-alpha")).restore.configState, "applied");
  await openRemote();
  await field("remote-refresh-backups").click(); await backupAction("delete_backup").click();
  await waitEnabled("remote-apply"); await field("remote-apply").click(); await waitOperation("已完成");
  await until(() => !fixture.state.backups.some((backup) => backup.id === selectedBackup.id));
  fixture.state.backups.push({ id: "a85a204d-8765-4719-a02a-5baee553ed87", format: "encrypted" });
  await field("remote-refresh-backups").click();
  const historical = ui.locator('#remote-backup-list [data-action="restore"][data-backup-id="a85a204d-8765-4719-a02a-5baee553ed87"]');
  await historical.waitFor(); assert.equal(await historical.isDisabled(), true);
  assert.match(await historical.getAttribute("title"), /原工具手动恢复/);
  assert.equal(await ui.locator('#remote-backup-list [data-action="delete_backup"][data-backup-id="a85a204d-8765-4719-a02a-5baee553ed87"]').isEnabled(), true);
  console.log("Remote UI: backup stays separate from update, archive restore/deletion and historical encrypted backup handling passed.");

  const webBefore = count("remote_web"); await field("remote-web-port").fill("4444"); await field("remote-web-port").focus();
  await page.waitForTimeout(2200); assert.equal(await field("remote-web-port").inputValue(), "4444");
  assert.equal(await field("remote-web-port").evaluate((node) => node === document.activeElement), true);
  assert.equal(count("remote_web"), webBefore);
  await field("remote-web-port").fill("3430"); await showWeb();
  assert.match(await field("remote-web-url").inputValue(), /fixture-management-key/);
  assert.ok(!(await field("toast").textContent()).includes("fixture-management-key"));
  const webTunnelPort = Number(new URL(await field("remote-web-url").inputValue()).port);
  await preview("stop"); await field("remote-apply").click(); await waitOperation("已完成");
  await until(() => !sessions.status("remote-alpha").forwards.some((forward) => forward.id === "magpie-web"));
  assert.equal(sessions.status("remote-alpha").state, "connected");
  assert.equal(await field("remote-web-url").inputValue(), "");
  await field("tab-logs").click();
  await ui.locator("#log-list .log-message").filter({ hasText: "远程 Magpie：停止服务" }).first().waitFor();
  assert.ok(!(await field("log-list").textContent()).includes("fixture-management-key"));
  assert.equal(await field("remote-operation").count(), 0);
  await field("log-filter").selectOption("error");
  assert.ok(!(await field("log-list").textContent()).includes("远程 Magpie：停止服务"));
  await field("log-filter").selectOption("all");
  await openRemote(); await preview("start"); await field("remote-apply").click(); await waitOperation("已完成"); await showWeb();
  assert.ok(webTunnelPort > 0);
  console.log("Remote UI: stop clears the Web address and forward while unified runtime logs show remote events without credentials.");
  const heldWeb = gateTool("remote_web");
  await field("remote-open-web").click(); await heldWeb.entered;
  await selectedRow("测试服务器").click(); await openRemote(); heldWeb.release();
  await page.waitForTimeout(150); assert.equal(await field("remote-web-url").inputValue(), "");
  await detect(); await showWeb();
  await preview("update");
  const disconnectedDownload = fixture.holdAction(); releases.push(disconnectedDownload.resolve);
  await field("remote-apply").click(); await disconnectedDownload.progress("updating", 8388608);
  await waitOperation("已下载 8 MB");
  await field("disconnect").click(); await field("detail-state").filter({ hasText: "未连接" }).waitFor();
  assert.ok(!(await field("remote-task-state").textContent()).includes("已下载"), "Disconnected sessions must hide cached active progress");
  disconnectedDownload.resolve();
  await until(async () => (await remote.operation("remote-beta")).state !== "running", "Disconnected task did not settle");
  fixture.state.reconcile = "succeeded";
  assert.equal(await field("remote-web-url").inputValue(), ""); assert.equal(await field("remote-action-update").isDisabled(), true);
  await field("connect").click(); await field("detail-state").filter({ hasText: "已连接" }).waitFor(); await detect(); await showWeb();
  await field("panel-remote").evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  assert.equal(await field("remote-web-url").inputValue(), "");
  const beforeRestore = count("remote_status");
  await field("panel-remote").evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await until(() => count("remote_status") > beforeRestore, "Remote status did not resume after restoring the cached page");
  const beforePolling = count("remote_status");
  await until(() => count("remote_status") > beforePolling, "Remote polling did not resume after restoring the cached page");
  await page.reload(); await field("service-state").filter({ hasText: "管理服务在线" }).waitFor(); await openRemote();
  console.log("Remote UI: explicit Web access, key cleanup and polling after cached-page restoration passed.");

  const heldPreview = gateTool("remote_preview");
  await field("remote-action-update").click(); await heldPreview.entered;
  await closePreview(); await selectedRow("测试服务器").click(); await openRemote(); heldPreview.release();
  await page.waitForTimeout(150); assert.equal(await field("remote-preview").evaluate((node) => node.open), false);
  assert.equal(await field("remote-backup-passphrase").count(), 0);
  await preview("restart");
  const heldCrossApply = gateTool("remote_apply"), crossAction = fixture.holdAction(); releases.push(crossAction.resolve);
  await field("remote-apply").click(); await heldCrossApply.entered; await closePreview();
  await selectedRow("生产服务器").click(); await openRemote();
  await until(async () => (await field("remote-task-state").textContent()).includes("启动服务：已完成"));
  const originalOperation = await field("remote-task-state").textContent();
  heldCrossApply.release(); crossAction.resolve(); await page.waitForTimeout(150);
  assert.equal(await field("remote-task-state").textContent(), originalOperation);
  await field("tab-forwards").click(); await page.waitForTimeout(150);
  const inactiveCount = count("remote_status"); await page.waitForTimeout(2200); assert.equal(count("remote_status"), inactiveCount);
  await field("tab-forwards").press("ArrowRight"); assert.equal(await field("tab-remote").getAttribute("aria-selected"), "true");
  await field("tab-remote").press("End"); assert.equal(await field("tab-logs").getAttribute("aria-selected"), "true");
  await openRemote();
  console.log("Remote UI: late preview/apply responses stay with their connection; inactive polling and keyboard navigation passed.");

  const executionsBeforeLostResponse = fixture.executions.filter((item) => item.kind === "action").length;
  await browserContext.route(api, async (route) => {
    if (route.request().postDataJSON()?.method === "remote_apply") await route.abort("failed");
    else await route.continue();
  });
  await preview("restart"); await field("remote-apply").click();
  await field("remote-preview-error").filter({ hasText: "提交结果待核实" }).waitFor(); await closePreview();
  await detect();
  assert.equal(await field("remote-action-restart").isDisabled(), true, "An older completed operation must not resolve a lost submission response");
  await browserContext.unroute(api);
  const replacement = await startManagementServer({ tools, recovery });
  await web.close(); web = replacement;
  const oldFrame = page.frames().find((item) => item.url().startsWith(api.replace("api/call", "")));
  assert.ok(oldFrame, "The management page should stay open during reconnection");
  await oldFrame.waitForFunction((url) => performance.getEntriesByType("resource").some((entry) => entry.name.startsWith(url + "api/snapshot")), web.url, { timeout: 15000 });
  await field("service-state").filter({ hasText: "管理服务在线" }).waitFor();
  await detect();
  assert.equal(await field("remote-action-restart").isDisabled(), true, "Reconnecting must not clear an unknown submission or retry it");
  await selectedRow("测试服务器").click(); await openRemote();
  await selectedRow("生产服务器").click(); await openRemote();
  await detect();
  assert.equal(await field("remote-action-restart").isDisabled(), true, "Changing connections must not clear an unknown submission");
  assert.ok(oldFrame.url().startsWith(api.replace("api/call", "")), "Unknown results must keep the current document open");
  assert.equal(fixture.executions.filter((item) => item.kind === "action").length, executionsBeforeLostResponse, "Reconnecting must not repeat the lost mutation");
  await page.reload(); await field("service-state").filter({ hasText: "管理服务在线" }).waitFor(); await openRemote();
  console.log("Remote UI: a lost apply response remains locked through management-service reconnection and connection changes.");

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
  await field("remote-view-logs").click();
  const sharedLogs = await field("log-list").textContent();
  assert.ok(!/MIGPIE_PROGRESS_V1|fixture-management-key|local-test-secret/.test(sharedLogs), "Shared logs must not expose progress transport records or credentials");
  assert.ok(!/fixture-management-key|local-test-secret/.test(await field("remote-task-state").textContent()));
  assert.ok(!/fixture-management-key|local-test-secret/.test(JSON.stringify(requests.filter((item) => ["remote_apply", "remote_preview"].includes(item.method)))));
  assert.equal(await field("remote-task-summary").count(), 1);
  assert.equal(await field("remote-operation").count(), 0);
  assert.deepEqual(errors, [], "Browser script errors");
  console.log(`Remote UI: 390px iframe and preview layout passed. Screenshots: ${screenshots}`);
} finally {
  for (const release of releases) release();
  for (const fn of cleanup) await fn();
}
