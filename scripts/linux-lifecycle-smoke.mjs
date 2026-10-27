import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { arch, release, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { actionScript, probeScript } from "../src/remote-scripts.mjs";
import { parseProbe } from "../src/remote.mjs";
import { backupInventoryScript, parseBackups } from "../src/remote-backups.mjs";
import { parseRestoreResult } from "../src/remote-results.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = {
  home: process.env.MIGPIE_LINUX_HOME,
  confirmHome: process.env.MIGPIE_LINUX_CONFIRM_HOME,
  manifest: process.env.MIGPIE_LINUX_RELEASE_MANIFEST,
  output: ".local/linux-lifecycle-result.json",
};
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === "--help") {
    console.log("Usage: node scripts/linux-lifecycle-smoke.mjs --home /home/magpie-acceptance-ID --confirm-home /home/magpie-acceptance-ID --release-manifest pinned-releases.json [--output result.json]\nOnly a disposable non-root magpie-acceptance-* account with its own real systemd --user session is allowed. The manifest must pin install {version,url,sha256}; optional update pins a second official asset. No sudo, credentials, command substitutes or host installation.");
    process.exit(0);
  }
  const key = { "--home": "home", "--confirm-home": "confirmHome", "--release-manifest": "manifest", "--output": "output" }[flag];
  if (!key || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) throw new Error(`Invalid argument: ${flag}`);
  options[key] = process.argv[++index];
}
function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}
// Kept identical to release-check.mjs; CRLF and LF checkouts bind the same sources.
async function sourceFingerprint() {
  const paths = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter((path) => /^(?:index\.mjs$|package(?:-lock)?\.json$|src\/|page\/|scripts\/|tests\/)/.test(path));
  for (const path of ["scripts/release-check.mjs", "scripts/linux-lifecycle-smoke.mjs"]) if (!paths.includes(path)) paths.push(path);
  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    let contents = await readFile(join(root, path));
    if (/\.(?:mjs|js|json|html|css|svg)$/.test(path)) contents = Buffer.from(contents.toString("utf8").replaceAll("\r\n", "\n"));
    hash.update(path + "\0").update(contents).update("\0");
  }
  return hash.digest("hex");
}
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
const within = (parent, child) => { const path = relative(parent, child); return path === "" || (!path.startsWith(".." + sep) && path !== ".." && !isAbsolute(path)); };
const output = resolve(root, options.output);
const report = {
  schemaVersion: 1, kind: "magpie-linux-lifecycle", execution: "real", substitutes: false,
  startedAt: new Date().toISOString(), commit: { sha: git(["rev-parse", "HEAD"]), dirty: Boolean(git(["status", "--porcelain"])) },
  sourceFingerprint: await sourceFingerprint(), runtime: { node: process.version },
  os: { platform: process.platform, architecture: arch(), release: release() },
  evidence: { dedicatedHome: false, systemdUser: false, officialAssets: false },
  releases: {}, checks: ["preflight", "install", "enable_web", "backup", "restore", "update", "uninstall", "cleanup"].map((id) => ({ id, status: "not_run", reason: "Prerequisites or earlier operations have not completed" })),
};
let environment, home, control, work, downloadRoot, uid, cleanupAllowed = false, interrupted = false;
let installRelease, updateRelease, instance;
const active = new Set();
const interrupt = () => { interrupted = true; for (const child of active) terminate(child, "SIGTERM"); };
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
function terminate(child, signal) { try { process.kill(-child.pid, signal); } catch { /* Already exited. */ } }
async function command(binary, args, { input, timeout = 120000, allowFailure = false } = {}) {
  assert.ok(!interrupted, "Lifecycle interrupted; only cleanup can continue");
  return new Promise((done, reject) => {
    let stdout = "", bytes = 0, problem;
    const child = spawn(binary, args, { cwd: control || root, env: environment, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    active.add(child);
    let hardStop;
    const stop = (message) => {
      problem ||= message;
      terminate(child, "SIGTERM");
      hardStop ||= setTimeout(() => terminate(child, "SIGKILL"), 3000);
    };
    const timer = setTimeout(() => stop("Command timed out; inspect the disposable user's service"), timeout);
    child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes > 512 * 1024) stop("Command output limit exceeded"); else stdout += chunk; });
    // Drain stderr without persisting CLI or systemd output, which may contain a Web key.
    child.stderr.on("data", (chunk) => { bytes += chunk.length; if (bytes > 512 * 1024) stop("Command output limit exceeded"); });
    child.stdin.on("error", () => {});
    child.once("error", (error) => { problem = `Unable to launch ${basename(binary)} (${error.code || "spawn"})`; });
    child.once("close", (code) => {
      active.delete(child); clearTimeout(timer); clearTimeout(hardStop);
      if (problem) reject(new Error(problem));
      else if (code !== 0 && !allowFailure) reject(new Error(`${basename(binary)} failed (exit ${code}); raw output deliberately omitted`));
      else done({ code, stdout });
    });
    child.stdin.end(input);
  });
}
const sh = (script, options = {}) => command("/usr/bin/sh", ["-s"], { ...options, input: script });
async function checked(id, callback) {
  const check = report.checks.find((item) => item.id === id);
  const started = Date.now();
  delete check.reason;
  console.log(`[running] real Linux ${id}`);
  try { await callback(check); check.status = "passed"; }
  catch (error) { check.status = "failed"; check.reason = error.message; throw error; }
  finally { check.durationMs = Date.now() - started; console.log(`[${check.status}] real Linux ${id}`); }
}
function pinnedRelease(value, name) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${name} release is required`);
  assert.match(value.version || "", /^v?\d+\.\d+\.\d+$/, `${name} requires a fixed version`);
  assert.match(value.sha256 || "", /^[a-f0-9]{64}$/i, `${name} requires a trusted SHA-256, not a placeholder`);
  assert.ok(!/^([a-f0-9])\1{63}$/i.test(value.sha256), `${name} SHA-256 is a placeholder`);
  const url = new URL(value.url);
  const asset = `magpie-cli-linux-${{ x64: "amd64", arm64: "arm64" }[process.arch]}`;
  const tag = url.pathname.split("/").at(-2);
  assert.ok(url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username && !url.password && !url.search && !url.hash
    && /^v?\d+\.\d+\.\d+$/.test(tag || "") && tag.replace(/^v/, "") === value.version.replace(/^v/, "")
    && url.pathname === `/yetone/magpie-releases/releases/download/${tag}/${asset}`, `${name} must name the fixed official Linux CLI asset for this architecture`);
  assert.ok(value.size === undefined || (Number.isSafeInteger(value.size) && value.size > 0 && value.size <= 1e12), "Omit size unless the actual official byte length is known");
  return { version: value.version, url: url.href, sha256: value.sha256.toLowerCase(), ...(value.size !== undefined && { size: value.size }) };
}
function versionNumber(version) {
  const match = String(version).match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:$|\s|\()/);
  assert.ok(match, "Actual Magpie version is not recognized");
  return match[1];
}
async function ownedDirectory(path) {
  const parts = relative(home, path).split(sep).filter(Boolean);
  assert.ok(within(home, path), "Path must stay inside disposable HOME");
  let current = home;
  for (const part of ["", ...parts]) {
    if (part) current = join(current, part);
    const info = await lstat(current);
    assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === uid && !(info.mode & 0o022), "Disposable HOME paths must be owned directories without links or group/world writes");
  }
}
async function probe() {
  const observed = parseProbe((await sh(probeScript)).stdout);
  assert.equal(observed.platform, "Linux"); assert.equal(observed.home, home);
  assert.equal(observed.managedBinary, join(home, ".local/bin/magpie"));
  assert.equal(observed.configDirectory, join(home, ".config/magpie"));
  assert.equal(observed.unit, join(home, ".config/systemd/user/magpie.service"));
  assert.equal(observed.systemd, true);
  if (observed.installed) assert.equal(observed.binary, observed.managedBinary, "Only this user's managed binary may run");
  return observed;
}
async function operation(action, releaseAsset, backup) {
  instance = await probe();
  const id = randomUUID();
  const result = await sh(actionScript(action, instance, id, releaseAsset, backup), { timeout: action === "update" ? 660000 : 420000, allowFailure: true });
  const records = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("MIGPIE_RESULT_V1\t"));
  assert.equal(records.length, 1, `${action} must produce one action result`);
  assert.equal(records[0], `MIGPIE_RESULT_V1\t${id}\tcompleted\t0\tnone\t${["backup", "restore", "update"].includes(action)}`, `${action} result did not complete successfully`);
  assert.equal(result.code, 0, `${action} exited with failure`);
  assert.ok(result.stdout.split(/\r?\n/).includes("MIGPIE_DONE"), `${action} completion marker is missing`);
  if (action === "restore") {
    const restore = parseRestoreResult(result.stdout, id);
    assert.equal(restore?.configState, "applied"); assert.equal(restore.rollbackState, "not_needed");
    assert.equal(restore.serviceState, instance.service.state === "running" ? "running" : "unchanged");
    assert.equal(restore.recoveryDirectory, join(home, ".config/magpie-remote/backups", id));
  }
  return id;
}
async function assertBinary(expected) {
  instance = await probe();
  assert.equal(instance.installed, true);
  assert.equal(versionNumber(instance.version), expected.version.replace(/^v/, ""), "Actual version differs from the pinned release");
  assert.equal(instance.binaryHash, expected.sha256, "Installed binary differs from the pinned official SHA-256");
  if (expected.size !== undefined) assert.equal((await stat(instance.binary)).size, expected.size, "Pinned byte length differs from installed binary");
  return { version: instance.version, sha256: instance.binaryHash, bytes: (await stat(instance.binary)).size };
}
async function assertUninstalled() {
  const observed = await probe();
  assert.equal(observed.installed, false, "Managed binary still exists");
  assert.equal(observed.service.installed, false, "User unit still exists");
  assert.notEqual(observed.service.state, "running", "Magpie user service is still active");
  assert.equal(await exists(join(home, ".local/bin/magpie")), false);
  const loaded = await command("/usr/bin/systemctl", ["--user", "show", "magpie.service", "--property=LoadState", "--value"], { allowFailure: true });
  assert.equal(loaded.stdout.trim(), "not-found", "Magpie unit is still loaded");
}
async function downloadPinned(asset) {
  const directory = await mkdtemp(join(downloadRoot, "asset-"));
  assert.deepEqual(await readdir(directory), []);
  const path = join(directory, "magpie-cli");
  await command("/usr/bin/curl", ["--disable", "-fLsS", "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "15", "--max-time", "300", asset.url, "-o", path], { timeout: 330000 });
  assert.equal(await sha256(path), asset.sha256, "Downloaded second asset failed SHA-256 verification");
  if (asset.size !== undefined) assert.equal((await stat(path)).size, asset.size, "Second asset byte length differs from manifest");
  return { sha256: asset.sha256, bytes: (await stat(path)).size };
}
async function removeOwnedFile(path) {
  if (!await exists(path)) return;
  await ownedDirectory(dirname(path));
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === uid, "Cleanup refuses files outside the owned regular-file scope");
  await unlink(path);
}
async function cleanup() {
  // Reset the interruption flag only for stopping this dedicated user's service.
  interrupted = false;
  const unit = join(home, ".config/systemd/user/magpie.service");
  const binary = join(home, ".local/bin/magpie");
  if (await exists(binary) && report.checks.find((item) => item.id === "uninstall").status === "not_run") {
    const digest = await sha256(binary);
    if ([installRelease?.sha256, updateRelease?.sha256].includes(digest)) {
      try { await checked("uninstall", async () => { await operation("uninstall"); }); } catch { /* Fall back to fixed systemctl cleanup. */ }
    }
  }
  await command("/usr/bin/systemctl", ["--user", "stop", "magpie.service"], { allowFailure: true });
  await command("/usr/bin/systemctl", ["--user", "disable", "magpie.service"], { allowFailure: true });
  await removeOwnedFile(unit);
  await removeOwnedFile(binary);
  const enabled = join(home, ".config/systemd/user/default.target.wants/magpie.service");
  if (await exists(enabled)) {
    await ownedDirectory(dirname(enabled));
    const info = await lstat(enabled);
    assert.ok(info.isSymbolicLink() && info.uid === uid && resolve(dirname(enabled), await readlink(enabled)) === unit, "Unexpected service enable link; inspect the disposable account");
    await unlink(enabled);
  }
  await command("/usr/bin/systemctl", ["--user", "daemon-reload"]);
  await command("/usr/bin/systemctl", ["--user", "reset-failed", "magpie.service"], { allowFailure: true });
  await assertUninstalled();
  report.cleanup = { serviceRemoved: true, binaryRemoved: true, homeRetained: true, backupsRetained: true };
}

try {
  await checked("preflight", async () => {
    assert.equal(process.platform, "linux", "Real Linux only; Git Bash, Windows and substitutes cannot perform this acceptance");
    assert.ok(["x64", "arm64"].includes(process.arch), "Only official Linux amd64/arm64 assets are supported");
    uid = process.getuid();
    assert.ok(uid >= 1000 && process.geteuid() === uid && !process.env.SUDO_USER && !process.env.SUDO_UID, "Run directly as a disposable non-root user; sudo is prohibited");
    assert.ok(options.home && isAbsolute(options.home) && normalize(options.home) === options.home && !/[\x00-\x20\x7f]/.test(options.home), "--home must explicitly name a canonical absolute path without whitespace/control characters");
    home = options.home;
    assert.equal(options.confirmHome, home, "--confirm-home / MIGPIE_LINUX_CONFIRM_HOME must repeat the disposable HOME exactly");
    assert.equal(process.env.HOME, home, "Log in as the disposable user; changing HOME on a daily account is insufficient");
    assert.equal(await realpath(home), home, "HOME must not contain symbolic links");
    assert.ok(home.split("/").filter(Boolean).length >= 2 && !within(home, root) && !within(root, home), "HOME must be separate from the checkout and cannot be a system root");
    assert.ok(!within(home, output), "Write result JSON outside the disposable HOME so it survives account cleanup");
    // No user PATH, shell startup, proxy variables, agents, provider keys or app data are inherited.
    environment = {
      PATH: "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
      XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
      LANG: "C.UTF-8", LC_ALL: "C.UTF-8", SYSTEMD_PAGER: "cat", SYSTEMD_COLORS: "0",
    };
    for (const tool of ["sh", "systemctl", "loginctl", "getent", "id", "curl", "sha256sum", "base64", "mktemp", "install", "readlink", "tar"]) {
      const path = await realpath("/usr/bin/" + tool);
      const info = await stat(path);
      assert.ok((path.startsWith("/usr/bin/") || path.startsWith("/bin/")) && info.isFile() && info.uid === 0 && !(info.mode & 0o022), `Require real root-owned system tool: ${tool}`);
    }
    const username = (await command("/usr/bin/id", ["-un"])).stdout.trim();
    assert.match(username, /^magpie-acceptance-[a-z0-9][a-z0-9_-]{2,}$/, "Use a disposable account named magpie-acceptance-ID");
    assert.equal(basename(home), username, "HOME basename must equal the disposable account name");
    environment.USER = username; environment.LOGNAME = username;
    const passwd = (await command("/usr/bin/getent", ["passwd", String(uid)])).stdout.trim().split(":");
    assert.equal(passwd[0], username); assert.equal(passwd[2], String(uid)); assert.equal(passwd[5], home, "Disposable HOME must be the account's registered HOME");
    await ownedDirectory(home);
    const allowed = new Set([".bashrc", ".profile", ".bash_profile", ".bash_logout", ".bash_history", ".lesshst", ".config", ".cache", ".local"]);
    for (const entry of await readdir(home, { withFileTypes: true })) {
      assert.ok(allowed.has(entry.name) && !entry.isSymbolicLink(), "HOME contains unexpected data; use a new account without credentials");
      if (!entry.name.match(/^\.(?:config|cache|local)$/)) assert.ok(entry.isFile(), "Unexpected HOME startup entry");
    }
    async function emptyTree(path, permitted) {
      if (!await exists(path)) return;
      await ownedDirectory(path);
      for (const name of await readdir(path)) {
        assert.ok(permitted[name], "Disposable app/config/cache directories must be empty before acceptance");
        await emptyTree(join(path, name), permitted[name]);
      }
    }
    await emptyTree(join(home, ".config"), { systemd: { user: {} } });
    await emptyTree(join(home, ".cache"), {});
    await emptyTree(join(home, ".local"), { bin: {}, share: {}, state: {} });
    const runtime = await lstat(environment.XDG_RUNTIME_DIR);
    assert.ok(runtime.isDirectory() && !runtime.isSymbolicLink() && runtime.uid === uid && !(runtime.mode & 0o077), "A real private /run/user/UID session is required");
    const bus = await lstat(join(environment.XDG_RUNTIME_DIR, "bus"));
    assert.ok(bus.isSocket() && bus.uid === uid, "A real user D-Bus socket is required");
    await command("/usr/bin/systemctl", ["--user", "show-environment"]);
    instance = await probe();
    assert.equal(instance.installed, false, "Do not reuse any existing Magpie installation");
    assert.equal(instance.service.installed, false);
    assert.equal(instance.locked, false);
    const unit = await command("/usr/bin/systemctl", ["--user", "show", "magpie.service", "--property=LoadState", "--value"], { allowFailure: true });
    assert.equal(unit.stdout.trim(), "not-found", "A Magpie user/system-wide unit already exists");
    assert.ok(options.manifest, "Provide --release-manifest / MIGPIE_LINUX_RELEASE_MANIFEST with trusted pinned assets");
    const manifestPath = resolve(root, options.manifest);
    assert.ok((await stat(manifestPath)).size <= 262144, "Release manifest is too large");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    installRelease = pinnedRelease(manifest.install, "install");
    if (manifest.update !== undefined) {
      updateRelease = pinnedRelease(manifest.update, "update");
      const before = installRelease.version.replace(/^v/, "").split(".").map(BigInt);
      const after = updateRelease.version.replace(/^v/, "").split(".").map(BigInt);
      const changed = before.findIndex((number, index) => number !== after[index]);
      assert.ok(changed >= 0 && after[changed] > before[changed] && updateRelease.sha256 !== installRelease.sha256, "Update must pin a distinct newer official release");
    }
    report.releases = { install: installRelease, ...(updateRelease && { update: updateRelease }) };
    report.evidence = { dedicatedHome: true, systemdUser: true, officialAssets: true, home, username, uid, runtimeDirectory: environment.XDG_RUNTIME_DIR };
    work = await mkdtemp(join(tmpdir(), "magpie-linux-lifecycle-"));
    control = join(work, "control"); downloadRoot = join(work, "downloads");
    await mkdir(control, { mode: 0o700 }); await mkdir(downloadRoot, { mode: 0o700 });
    await mkdir(join(control, "tmp"), { mode: 0o700 });
    environment.TMPDIR = join(control, "tmp");
    cleanupAllowed = true;
  });
  await checked("install", async (check) => {
    check.operationId = await operation("install", installRelease);
    check.observed = await assertBinary(installRelease);
    for (const capability of ["daemon_install_web", "daemon_uninstall", "daemon_start", "daemon_stop", "healthcheck"]) assert.ok(instance.capabilities.includes(capability), `Pinned CLI lacks required capability ${capability}`);
  });
  await checked("enable_web", async (check) => {
    check.operationId = await operation("enable_web"); instance = await probe();
    assert.equal(instance.service.installed, true); assert.equal(instance.service.state, "running");
    assert.equal(instance.web.enabled, true); assert.equal(instance.web.port, 3430);
    // Never request daemon web: it prints a management key.
  });
  const marker = randomUUID(), markerPath = join(home, ".config/magpie/acceptance-marker.txt"), extraPath = join(home, ".config/magpie/acceptance-extra.txt");
  let selected;
  await checked("backup", async (check) => {
    await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 }); await ownedDirectory(dirname(markerPath));
    await writeFile(markerPath, marker, { flag: "wx", mode: 0o600 });
    check.operationId = await operation("backup");
    selected = parseBackups((await sh(backupInventoryScript)).stdout, instance.configDirectory).find((backup) => backup.id === check.operationId);
    assert.equal(selected?.format, "archive"); assert.equal(selected.hasBinary, true);
    assert.equal(await sha256(join(selected.directory, "magpie")), installRelease.sha256);
    check.backupId = selected.id; check.fingerprint = selected.fingerprint;
  });
  await checked("restore", async (check) => {
    await writeFile(markerPath, "synthetic-change", { mode: 0o600 }); await writeFile(extraPath, "synthetic-extra", { flag: "wx", mode: 0o600 });
    check.operationId = await operation("restore", undefined, selected);
    assert.equal(await readFile(markerPath, "utf8"), marker); assert.equal(await exists(extraPath), false);
    check.observed = await assertBinary(installRelease); assert.equal(instance.service.state, "running");
    const beforeRestore = parseBackups((await sh(backupInventoryScript)).stdout, instance.configDirectory).find((backup) => backup.id === check.operationId);
    assert.equal(beforeRestore?.format, "archive", "Restore must retain a pre-restore snapshot");
  });
  if (updateRelease) {
    await checked("update", async (check) => {
      check.download = await downloadPinned(updateRelease);
      const feed = await command("/usr/bin/curl", ["--disable", "-fsS", "--proto", "=https", "--connect-timeout", "15", "--max-time", "30", "https://usemagpie.ai/api/latest"], { timeout: 45000 });
      const latest = JSON.parse(feed.stdout);
      const asset = latest.assets?.[`magpie-cli-linux-${process.arch === "x64" ? "amd64" : "arm64"}`];
      assert.equal(latest.version?.replace(/^v/, ""), updateRelease.version.replace(/^v/, ""), "Official latest changed; native magpie update cannot pin historical targets");
      assert.equal(asset?.url, updateRelease.url, "Official update asset URL changed");
      assert.equal(asset?.sha256?.toLowerCase(), updateRelease.sha256, "Official update asset SHA-256 changed");
      check.operationId = await operation("update");
      check.observed = await assertBinary(updateRelease); assert.equal(instance.service.state, "running");
    });
  } else report.checks.find((check) => check.id === "update").reason = "No second pinned official version/asset supplied; native update was not run";
  await checked("uninstall", async (check) => { check.operationId = await operation("uninstall"); });
} catch (error) {
  report.error = error.message;
  console.error(`Real Linux acceptance stopped: ${error.message}`);
} finally {
  if (cleanupAllowed) {
    try { await checked("cleanup", cleanup); }
    catch (error) { report.error ||= error.message; }
  }
  if (work) {
    try { await rm(work, { recursive: true, force: true }); }
    catch { report.checks.push({ id: "temporary-cleanup", status: "failed", reason: "Temporary files could not be removed; inspect the disposable environment" }); }
  }
  try {
    if (await sourceFingerprint() !== report.sourceFingerprint || git(["rev-parse", "HEAD"]) !== report.commit.sha) throw new Error("Source changed while Linux acceptance was running");
  } catch (error) { report.checks.push({ id: "source-stable", status: "failed", reason: error.message }); }
  report.finishedAt = new Date().toISOString();
  report.unaccepted = report.checks.filter((check) => check.status !== "passed").map(({ id, status, reason }) => ({ id, status, reason }));
  report.corePassed = ["preflight", "install", "enable_web", "backup", "restore", "uninstall", "cleanup"].every((id) => report.checks.find((check) => check.id === id).status === "passed");
  report.status = report.checks.some((check) => check.status === "failed") ? "failed" : report.unaccepted.length ? "incomplete" : "passed";
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(`Real Linux acceptance: ${report.status}; report: ${output}`);
  process.exitCode = report.corePassed && report.status !== "failed" ? 0 : 1;
}
