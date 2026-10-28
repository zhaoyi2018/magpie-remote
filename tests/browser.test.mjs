import test from "node:test";
import assert from "node:assert/strict";
import { openWebBrowser } from "../src/browser.mjs";

const url = "http://127.0.0.1:12345/?k=fixture-management-key-1234567890";

test("browser opening passes the loopback link as a separate argument without a shell", async () => {
  for (const [platform, command, args] of [
    ["win32", "rundll32.exe", ["url.dll,FileProtocolHandler", url]],
    ["darwin", "open", [url]],
    ["linux", "xdg-open", [url]],
  ]) {
    const calls = [];
    await openWebBrowser(url, { platform, execute: async (...args) => calls.push(args) });
    assert.deepEqual(calls, [[command, args, { windowsHide: true, timeout: 10000 }]]);
  }
});

test("browser opening rejects external destinations, shell payloads and invalid ports", async () => {
  for (const value of ["https://example.com/", "file:///etc/passwd", "javascript:alert(1)", url + "&calc", url.replace("12345", "0"), url.replace("12345", "65536"), url + "\n", null]) {
    let opened = false;
    await assert.rejects(openWebBrowser(value, { execute: async () => { opened = true; } }));
    assert.equal(opened, false);
  }
});

test("browser launch failures do not expose the management key", async () => {
  await assert.rejects(openWebBrowser(url, { execute: async () => { throw new Error("command failed: " + url); } }), (error) => {
    assert.match(error.message, /复制地址/);
    assert.ok(!error.message.includes("fixture-management-key"));
    return true;
  });
});
