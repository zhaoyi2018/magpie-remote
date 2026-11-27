import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

test("resource library entry and preview controls are available in the management page", async () => {
  const html = await readFile(new URL("../page/manage.html", import.meta.url), "utf8");
  assert.match(html, /id="remote-library-details"/);
  assert.match(html, /id="remote-action-library_sync"/);
  for (const category of ["instructions", "skills", "mcp", "commands"]) assert.match(html, new RegExp(`value="${category}"`));
  assert.match(html, /id="remote-library-mirror"/);
});

test("library preview updates selections safely and submits the newest revision", async (t) => {
  const executablePath = process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : undefined;
  if (executablePath && !existsSync(executablePath)) return t.skip("Chrome is unavailable");
  let browser;
  try { browser = await chromium.launch({ headless: true, ...(executablePath && { executablePath }) }); }
  catch { return t.skip("Chromium is unavailable"); }
  t.after(() => browser.close());
  const page = await browser.newPage();
  const html = await readFile(new URL("../page/manage.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../page/remote.js", import.meta.url), "utf8");
  await page.setContent(html.replace(/<script\b[^>]*>\s*<\/script>/g, ""));
  await page.evaluate(() => { document.querySelector("#connection-detail").hidden = false; document.querySelector("#panel-remote").hidden = false; });
  await page.evaluate(async (source) => {
    const { createRemoteManager } = await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    window.calls = []; window.pending = [];
    const call = (method, args, _credentials, { signal } = {}) => {
      window.calls.push({ method, args });
      if (method === "remote_status") return Promise.resolve({ connectionId: "one", instance: { installed: true, platform: "Linux", systemd: false, service: {} }, actions: { library_sync: { enabled: true } } });
      if (method === "remote_preview") return new Promise((resolve, reject) => {
        window.pending.push({ args, resolve, signal });
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      if (method === "remote_apply") return Promise.resolve({ id: "task", action: "library_sync", state: "succeeded" });
      return Promise.resolve({ connectionId: "one", backups: [] });
    };
    window.manager = createRemoteManager({ call, toast() {} });
    window.manager.render({ connection: { id: "one", name: "test", username: "u", host: "host" }, session: { state: "connected" } }, { online: true, active: true });
  }, script);
  await page.waitForFunction(() => !document.querySelector("#remote-action-library_sync").disabled);
  await page.locator("#remote-library-details summary").click();
  await page.locator("#remote-action-library_sync").click();
  await page.waitForFunction(() => window.pending.length === 1);
  assert.deepEqual(await page.evaluate(() => window.pending[0].args.categories), ["instructions", "skills", "mcp"]);
  await page.evaluate(() => {
    document.querySelector('#remote-library-options input[value="skills"]').click();
    document.querySelector('#remote-library-options input[value="commands"]').click();
    document.querySelector("#remote-library-mirror").click();
    if (window.pending.length !== 1 || !document.querySelector("#remote-apply").disabled) throw Error("Options must immediately invalidate the old preview and debounce the request");
    if (!window.pending[0].signal?.aborted) throw Error("Changing options must abort the previous request immediately");
  });
  await page.waitForFunction(() => window.pending.length === 2);
  await page.evaluate(() => {
    const result = (pending, revision) => ({ connectionId: "one", action: "library_sync", revision, previewSession: "a".repeat(64), summary: revision, changes: [], warnings: [], library: { mode: pending.args.mode, categories: pending.args.categories, activation: "supported", warnings: [{ name: "server", message: "Windows MCP" }], counts: { mcp: { added: 6, removed: 6 }, commands: { removed: 2 } }, details: { mcp: { added: Array.from({ length: 6 }, (_, i) => ({ name: i ? `item ${i}` : "<unsafe>", kind: "entry", envCount: 2 })), removed: Array.from({ length: 6 }, (_, i) => ({ name: `removed ${i}` })) } } } });
    window.pending[1].resolve(result(window.pending[1], "new"));
    window.pending[0].resolve(result(window.pending[0], "old"));
  });
  await page.waitForFunction(() => document.querySelector("#remote-preview-summary").textContent === "new");
  assert.equal(await page.locator("#remote-library-categories").locator("text=<unsafe>").count(), 1);
  assert.equal(await page.locator("#remote-library-categories unsafe").count(), 0);
  assert.match(await page.locator("#remote-library-categories").textContent(), /环境变量 2/);
  assert.match(await page.locator("#remote-preview-warnings").innerText(), /Windows MCP/);
  const mcp = page.locator(".remote-library-card").filter({ hasText: "<unsafe>" });
  assert.equal(await mcp.locator(".remote-library-count.is-added:not(.is-zero)").count(), 1);
  assert.equal(await mcp.locator(".remote-library-count.is-updated.is-zero").count(), 1);
  assert.equal(await mcp.locator(".remote-library-count.is-removed:not(.is-zero)").count(), 1);
  assert.equal(await mcp.locator(".remote-library-count.is-skipped.is-zero, .remote-library-count.is-preserved.is-zero").count(), 2);
  assert.equal(await page.locator(".remote-library-empty", { hasText: "与远端一致，无变更。" }).count(), 2);
  assert.equal(await mcp.locator("details.remote-library-detail.is-added:not([open]) li").count(), 6);
  assert.equal(await mcp.locator("div.remote-library-detail.is-removed li:visible").count(), 6);
  assert.equal(await page.locator("#remote-apply").getAttribute("class"), "button danger");
  assert.equal(await page.locator("#remote-apply").innerText(), "确认镜像同步（移除 8 项）");
  await page.locator("#remote-library-mirror").uncheck();
  assert.equal(await page.locator("#remote-apply").getAttribute("class"), "button primary");
  await page.waitForFunction(() => window.pending.length === 3);
  assert.equal(await page.evaluate(() => window.pending[2].args.previewSession), "a".repeat(64));
  await page.evaluate(() => { const p = window.pending.at(-1); p.resolve({ connectionId: "one", action: "library_sync", revision: "merge", summary: "merge", changes: [], warnings: [], library: { mode: "merge", categories: p.args.categories, counts: {}, details: {} } }); });
  await page.waitForFunction(() => document.querySelector("#remote-preview-summary").textContent === "merge");
  assert.equal(await page.locator("#remote-apply").innerText(), "确认同步资源库");
  await page.evaluate(() => {
    document.querySelector("#remote-library-mirror").click();
    for (const input of document.querySelectorAll('#remote-library-options input[name="library-category"]:checked')) input.click();
  });
  assert.equal(await page.locator("#remote-library-selection-error").isVisible(), true);
  assert.equal(await page.locator("#remote-apply").isDisabled(), true);
  const count = await page.evaluate(() => window.pending.length);
  assert.equal(count, 3);
  await page.locator('#remote-library-options input[value="mcp"]').check();
  await page.waitForFunction(() => window.pending.length === 4);
  await page.evaluate(() => { const p = window.pending.at(-1); p.resolve({ connectionId: "one", action: "library_sync", revision: "final", summary: "final", changes: [], warnings: [], library: { categories: p.args.categories, activation: "supported", counts: {}, details: {} } }); });
  await page.waitForFunction(() => !document.querySelector("#remote-apply").disabled);
  await page.locator("#remote-apply").click();
  await page.waitForFunction(() => window.calls.some((call) => call.method === "remote_apply"));
  const calls = await page.evaluate(() => window.calls);
  assert.deepEqual(calls.filter((call) => call.method === "remote_apply")[0].args, { connectionId: "one", action: "library_sync", revision: "final" });
  assert.deepEqual(calls.filter((call) => call.method === "remote_preview").at(-1).args.categories, ["mcp"]);
  assert.equal(calls.filter((call) => call.method === "remote_preview").at(-1).args.mode, "mirror");
  await page.waitForFunction(() => !document.querySelector("#remote-preview").open);
  await page.waitForFunction(() => !document.querySelector("#remote-action-library_sync").disabled);
  await page.locator("#remote-action-library_sync").click();
  await page.waitForFunction(() => window.pending.length === 5);
  assert.equal(await page.evaluate(() => window.pending[4].args.previewSession), undefined);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.pending[4].signal?.aborted);
  assert.equal(await page.locator("#remote-preview-error").textContent(), "");
  await page.locator("#remote-action-library_sync").click();
  await page.waitForFunction(() => window.pending.length === 6);
  await page.locator(".remote-close-preview").first().click();
  assert.equal(await page.evaluate(() => window.pending[5].signal.aborted), true);
});
