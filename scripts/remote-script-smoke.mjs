import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { actionScript, probeScript, shellQuote } from "../src/remote-scripts.mjs";
import { parseProbe } from "../src/remote.mjs";

// Runs generated POSIX scripts with a fake Magpie executable and service manager.
// It never downloads a release or invokes an installed Magpie.
const git = process.platform === "win32" ? spawnSync("where.exe", ["git"], { encoding: "utf8" }).stdout?.trim().split(/\r?\n/)[0] : undefined;
const bundledBash = git && join(dirname(dirname(git)), "bin", "bash.exe");
const bash = process.env.MIGPIE_BASH || (bundledBash && existsSync(bundledBash) ? bundledBash : "bash");
const directory = await mkdtemp(join(tmpdir(), "migpie-script-smoke-"));
const home = join(directory, "home"), tools = join(directory, "tools");
const run = (script, input = "") => new Promise((resolveRun, reject) => {
  const setup = `export HOME="$(cd ${shellQuote(home.replaceAll("\\", "/"))} && pwd -P)"\nexport XDG_CONFIG_HOME="$HOME/.config"\nexport PATH="$(cd ${shellQuote(tools.replaceAll("\\", "/"))} && pwd -P):$PATH"\n`;
  const child = spawn(bash, ["-c", setup + script], { env: { ...process.env, MSYS_NO_PATHCONV: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const timer = setTimeout(() => { child.kill(); reject(new Error("Script smoke timed out")); }, 10000);
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("close", (code) => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
  child.stdin.end(input);
});
const id = "c2be46f1-cf7c-4e27-a5ef-c0786bb4fb05";
try {
  await Promise.all([mkdir(home), mkdir(tools)]);
  const fake = `#!/bin/sh
set -eu
state="$HOME/service-state"
case "$1" in
  --version) printf 'magpie 0.1.1472\\n' ;;
  backup) IFS= read -r secret; [ "$secret" = 'test-backup-secret-12' ]; if [ -e "$HOME/fail-backup" ]; then exit 42; fi; printf 'encrypted-test-backup' > "$2" ;;
  update) [ ! -e "$HOME/fail-backup" ]; printf updated > "$HOME/updated" ;;
  healthcheck) [ "$(cat "$state" 2>/dev/null)" = running ] ;;
  daemon) case "$2" in
    install|restart|start) printf running > "$state" ;;
    stop) printf stopped > "$state" ;;
    uninstall) rm -f "$HOME/.config/systemd/user/magpie.service" "$state" ;;
    *) exit 3 ;;
  esac ;;
  *) exit 4 ;;
esac
`;
  await writeFile(join(tools, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
  await writeFile(join(tools, "systemctl"), "#!/bin/sh\ncase \"$*\" in *show-environment*) exit 0;; *ActiveState*) printf active;; esac\n", { mode: 0o755 });
  await writeFile(join(tools, "loginctl"), "#!/bin/sh\nprintf 'yes\\n'\n", { mode: 0o755 });
  const posixHome = (await run('cd "$HOME" && pwd -P')).stdout.trim();
  const binary = posixHome + "/.local/bin/magpie";
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });
  await writeFile(join(home, ".local", "bin", "magpie"), fake, { mode: 0o755 });
  await writeFile(join(home, ".config", "systemd", "user", "magpie.service"), '[Service]\nExecStart="' + binary + '" "serve" "--web=127.0.0.1:3430"\nEnvironment="MAGPIE_WEB_KEY=isolated-script-secret"\n');
  const probe = await run(probeScript); assert.equal(probe.code, 0, probe.stderr);
  const instance = parseProbe(probe.stdout);
  assert.equal(instance.platform, "Linux"); assert.equal(instance.installed, true); assert.equal(instance.web.port, 3430);
  assert.ok(!probe.stdout.includes("isolated-script-secret"));
  // Use a canonical HOME for the scripts' explicit default-path ownership check.
  const canonical = 'export HOME=' + "'" + posixHome.replaceAll("'", "'\\''") + "'\n";
  const update = actionScript("update", instance, id);
  await writeFile(join(home, "service-state"), "running");
  const updated = await run(canonical + update, "test-backup-secret-12\n"); assert.equal(updated.code, 0, updated.stderr); assert.match(updated.stdout, /MIGPIE_DONE/);
  assert.equal(await readFile(join(home, "updated"), "utf8"), "updated");
  assert.equal(await readFile(join(home, ".config", "magpie-remote", "backups", id, "config.magpie"), "utf8"), "encrypted-test-backup");
  await rm(join(home, "updated")); await writeFile(join(home, "fail-backup"), "fail");
  const failed = await run(canonical + actionScript("update", instance, "d144400f-57fc-47be-aa55-f1ea81e01f7b"), "test-backup-secret-12\n");
  assert.notEqual(failed.code, 0); await assert.rejects(access(join(home, "updated")));
  assert.equal(await readFile(join(home, ".config", "magpie-remote", "operations", "d144400f-57fc-47be-aa55-f1ea81e01f7b", "state"), "utf8"), "failed");
  const uninstalled = await run(canonical + actionScript("uninstall", { ...instance, binary, managedBinary: binary }, "5d140b01-7a34-432b-ac15-934fba8fc9ae"));
  assert.equal(uninstalled.code, 0, uninstalled.stderr); await assert.rejects(access(join(home, ".local", "bin", "magpie")));
  assert.ok((await readFile(join(home, ".config", "magpie-remote", "backups", id, "config.magpie"))).length);
  await writeFile(join(tools, "curl"), '#!/bin/sh\nfor output; do :; done\ncp "$HOME/release-source" "$output"\n', { mode: 0o755 });
  await writeFile(join(home, "release-source"), fake, { mode: 0o755 });
  const release = { version: "0.1.1472", sha256: createHash("sha256").update(fake).digest("hex"), url: "https://github.com/yetone/magpie-releases/releases/download/test/magpie-cli-linux-amd64" };
  const empty = parseProbe((await run(probeScript)).stdout);
  const badInstall = await run(actionScript("install", empty, "2d5d6952-bf60-47ad-b2c7-d4624bcb51dc", { ...release, sha256: "0".repeat(64) }));
  assert.notEqual(badInstall.code, 0); await assert.rejects(access(join(home, ".local", "bin", "magpie")));
  const installed = await run(actionScript("install", empty, "23737f6f-cc09-46d2-85dd-c7ba7965e42c", release));
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal(await readFile(join(home, ".local", "bin", "magpie"), "utf8"), fake);
  for (const action of ["enable_web", "stop", "start", "restart"]) {
    const observed = parseProbe((await run(probeScript)).stdout);
    const result = await run(actionScript(action, observed, randomUUID()));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(join(home, "service-state"), "utf8"), action === "stop" ? "stopped" : "running");
  }
  const observed = parseProbe((await run(probeScript)).stdout);
  await mkdir(join(home, ".config", "magpie-remote", "operation.lock"));
  const locked = await run(actionScript("stop", observed, randomUUID()));
  assert.equal(locked.code, 75);
  assert.equal(await readFile(join(home, "service-state"), "utf8"), "running");
  await rm(join(home, ".config", "magpie-remote", "operation.lock"), { recursive: true });
  console.log("Remote scripts: POSIX probe, checksum-verified install and checksum failure, stdin backup and failure protection, service actions, lock exclusion, completion records and uninstall retaining backups passed.");
} finally {
  if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith("migpie-script-smoke-")) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
