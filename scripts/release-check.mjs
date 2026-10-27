import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, release } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = {
  bun: process.env.MIGPIE_RELEASE_BUN,
  host: process.env.MIGPIE_RELEASE_HOST,
  linuxResult: process.env.MIGPIE_RELEASE_LINUX_RESULT,
  output: ".local/release-check.json",
};
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === "--help") {
    console.log("Usage: node scripts/release-check.mjs [--strict] [--skip-ui] [--bun /path/to/bun] [--host /path/to/host.js] [--linux-result result.json] [--output result.json]\nBun must be exactly 1.4.3. Missing external acceptance is not_run; --strict requires every check, including Linux update. --skip-ui records both browser checks as not_run.");
    process.exit(0);
  }
  if (flag === "--strict" || flag === "--skip-ui") { options[flag.slice(2)] = true; continue; }
  const key = { "--bun": "bun", "--host": "host", "--linux-result": "linuxResult", "--output": "output" }[flag];
  if (!key || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) throw new Error(`Invalid argument: ${flag}`);
  options[key] = process.argv[++index];
}
for (const key of ["bun", "host"]) {
  if (options[key] && !isAbsolute(options[key])) throw new Error(`--${key} / its environment variable must be an absolute path`);
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}
// Normalize text line endings so the same checkout can be compared across OSes.
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

const output = resolve(root, options.output);
const logDirectory = join(dirname(output), "release-logs", new Date().toISOString().replaceAll(/[:.]/g, "-"));
await mkdir(logDirectory, { recursive: true });
const report = {
  schemaVersion: 1, kind: "magpie-release-check", startedAt: new Date().toISOString(),
  strict: Boolean(options.strict),
  commit: { sha: git(["rev-parse", "HEAD"]), dirty: Boolean(git(["status", "--porcelain"])) },
  sourceFingerprint: await sourceFingerprint(),
  runtime: { node: { executable: process.execPath, version: process.version }, bun: null, magpieHost: null },
  os: { platform: process.platform, architecture: arch(), release: release() },
  checks: [], package: null, unaccepted: [], complete: false, gatePassed: false,
};
const npmCLI = process.env.npm_execpath && basename(process.env.npm_execpath) === "npm-cli.js" ? process.env.npm_execpath : join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const npm = process.platform === "win32" ? [process.execPath, npmCLI] : ["npm"];

function notRun(id, scope, reason) {
  const check = { id, scope, status: "not_run", reason };
  report.checks.push(check);
  console.log(`[not_run] ${id}: ${reason}`);
  return check;
}
async function run(id, scope, command, { capture = false } = {}) {
  const started = Date.now();
  const check = { id, scope, command, status: "failed", log: join(logDirectory, id + ".log") };
  report.checks.push(check);
  console.log(`[running] ${id}`);
  const chunks = [];
  let stdout = "", reason, size = 0;
  const result = await new Promise((done) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    });
    const collect = (chunk, isError) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) { reason = "Output limit exceeded"; child.kill(); return; }
      chunks.push(chunk);
      if (capture && !isError) stdout += chunk;
      if (!capture) (isError ? process.stderr : process.stdout).write(chunk);
    };
    child.stdout.on("data", (chunk) => collect(chunk, false));
    child.stderr.on("data", (chunk) => collect(chunk, true));
    child.once("error", (error) => { reason = error.code === "ENOENT" ? "Executable not found" : error.message; });
    child.once("close", (code, signal) => done({ code, signal }));
  });
  await writeFile(check.log, Buffer.concat(chunks), { mode: 0o600 });
  check.code = result.code;
  check.durationMs = Date.now() - started;
  check.status = result.code === 0 && !reason ? "passed" : "failed";
  if (reason || result.signal) check.reason = reason || `Terminated by ${result.signal}`;
  console.log(`[${check.status}] ${id}`);
  return { check, stdout };
}
function rejectCheck(check, reason) { check.status = "failed"; check.reason = reason; }

try {
  for (const [id, args] of [
    ["check", ["run", "check"]], ["node-tests", ["test"]], ["remote-script-fixtures", ["run", "test:remote"]],
    ["ui", ["run", "test:ui"]], ["remote-ui-fixtures", ["run", "test:ui:remote"]],
  ]) {
    if (options["skip-ui"] && ["ui", "remote-ui-fixtures"].includes(id)) notRun(id, "local", "Explicit --skip-ui; requires a browser job");
    else await run(id, id.includes("fixtures") ? "fixture" : "local", [...npm, ...args]);
  }
  // Keep a named Node SSH result even when testing compatibility under Bun.
  await run("node-ssh-regression", "local-ssh", [process.execPath, "--test", "--test-concurrency=1", "tests/remote-exec.test.mjs", "tests/sessions.test.mjs"]);

  const discoveredBun = (process.env.PATH || "").split(delimiter).map((directory) => join(directory, process.platform === "win32" ? "bun.exe" : "bun")).find((path) => existsSync(path));
  const bunCommand = options.bun || discoveredBun || "bun";
  const bun = await run("bun-version", "external-runtime", [bunCommand, "--version"], { capture: true });
  if (bun.check.reason === "Executable not found" || (options.bun && !existsSync(options.bun))) {
    bun.check.status = "not_run"; bun.check.reason = "Bun is unavailable; set --bun or MIGPIE_RELEASE_BUN";
  } else if (bun.check.status === "passed" && bun.stdout.trim() !== "1.4.3") rejectCheck(bun.check, "Bun must be exactly 1.4.3");
  report.runtime.bun = { executable: bunCommand, version: bun.stdout.trim() || null };
  if (bun.check.status === "passed") await run("bun-tests", "external-runtime", [bunCommand, "test", "tests", "--timeout", "15000", "--max-concurrency", "1"]);
  else notRun("bun-tests", "external-runtime", "Bun 1.4.3 has not been verified");

  if (!options.host || !existsSync(options.host)) notRun("magpie-host", "actual-host", "Set --host or MIGPIE_RELEASE_HOST to an existing official host-*.js; no daily host is searched or reloaded");
  else if (bun.check.status !== "passed") notRun("magpie-host", "actual-host", "Requires verified Bun 1.4.3");
  else {
    report.runtime.magpieHost = { path: options.host, sha256: createHash("sha256").update(await readFile(options.host)).digest("hex") };
    await run("magpie-host", "actual-host", [process.execPath, "scripts/host-smoke.mjs", resolve(bunCommand), options.host]);
  }

  // Never run prepack here: prepack already invokes check/test and can recurse.
  const packed = await run("package-dry-run", "package", [...npm, "pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true });
  if (packed.check.status === "passed") {
    try {
      const [pack] = JSON.parse(packed.stdout);
      if (!Array.isArray(pack?.files) || !pack.files.length) throw new Error("npm returned no package file inventory");
      report.package = { name: pack.name, version: pack.version, filename: pack.filename, size: pack.size, unpackedSize: pack.unpackedSize, files: pack.files };
      const names = new Set(pack.files.map((file) => file.path));
      for (const required of ["package.json", "index.mjs", "src/remote.mjs", "src/remote-scripts.mjs", "src/remote-backups.mjs", "src/remote-results.mjs"]) if (!names.has(required)) throw new Error(`Required package file missing: ${required}`);
      for (const name of names) if (/^(?:node_modules|tests|scripts|\.github|\.local|\.sandbox)\/|(?:^|\/)\.runtime\/|(?:^|\/)\.env(?:\.|$)|(?:^|\/)\.ssh\//.test(name)) throw new Error(`Private/development file in package: ${name}`);
    } catch (error) { rejectCheck(packed.check, error.message); }
  }

  const linuxIDs = ["install", "enable_web", "backup", "restore", "uninstall", "cleanup", "update"];
  if (!options.linuxResult || !existsSync(resolve(root, options.linuxResult))) {
    for (const id of linuxIDs) notRun("linux-" + id, "real-linux", "Provide --linux-result / MIGPIE_RELEASE_LINUX_RESULT from the dedicated real Linux entry point");
  } else {
    try {
      const linuxPath = resolve(root, options.linuxResult);
      const linux = JSON.parse(await readFile(linuxPath, "utf8"));
      if (linux.schemaVersion !== 1 || linux.kind !== "magpie-linux-lifecycle" || linux.execution !== "real" || linux.substitutes !== false || linux.os?.platform !== "linux"
        || !["passed", "incomplete"].includes(linux.status) || linux.corePassed !== true || linux.checks?.some((check) => check.status === "failed")
        || linux.commit?.sha !== report.commit.sha || linux.sourceFingerprint !== report.sourceFingerprint
        || linux.evidence?.systemdUser !== true || linux.evidence?.dedicatedHome !== true || linux.evidence?.officialAssets !== true || !Array.isArray(linux.checks)) {
        throw new Error("Linux evidence must be real, use the same commit/source fingerprint, and prove dedicated HOME, official assets and systemd --user");
      }
      report.linuxResult = { path: linuxPath, sha256: createHash("sha256").update(await readFile(linuxPath)).digest("hex"), finishedAt: linux.finishedAt, os: linux.os, releases: linux.releases };
      for (const id of linuxIDs) {
        const matches = linux.checks.filter((check) => check.id === id);
        const check = matches.length === 1 ? matches[0] : null;
        const status = ["passed", "failed", "not_run"].includes(check?.status) ? check.status : "not_run";
        report.checks.push({ id: "linux-" + id, scope: "real-linux", status, evidence: linuxPath, ...(status !== "passed" && { reason: check?.reason || "No unambiguous result for this Linux operation" }) });
      }
    } catch (error) {
      report.checks.push({ id: "linux-evidence", scope: "real-linux", status: "failed", reason: error.message });
      for (const id of linuxIDs) notRun("linux-" + id, "real-linux", "Linux evidence was rejected");
    }
  }
  const stable = await sourceFingerprint() === report.sourceFingerprint && git(["rev-parse", "HEAD"]) === report.commit.sha;
  report.checks.push({ id: "source-stable", scope: "source", status: stable ? "passed" : "failed", ...(!stable && { reason: "Source or commit changed while the gate was running; rerun on a stable snapshot" }) });
} catch (error) {
  report.checks.push({ id: "gate-error", scope: "gate", status: "failed", reason: error.message });
} finally {
  report.finishedAt = new Date().toISOString();
  report.unaccepted = report.checks.filter((check) => check.status !== "passed").map(({ id, scope, status, reason }) => ({ id, scope, status, reason: reason || "Command failed; see check log" }));
  report.complete = report.unaccepted.length === 0;
  report.gatePassed = !report.checks.some((check) => check.status === "failed") && (!options.strict || report.complete);
  report.status = report.complete ? "passed" : report.checks.some((check) => check.status === "failed") ? "failed" : "incomplete";
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(`Release checks: ${report.status}; gate ${report.gatePassed ? "passed" : "failed"}; report: ${output}`);
  process.exitCode = report.gatePassed ? 0 : 1;
}
