import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { actionScript, probeScript, shellQuote } from "../src/remote-scripts.mjs";
import { parseProbe } from "../src/remote.mjs";
import { backupInventoryScript, parseBackups } from "../src/remote-backups.mjs";

// Runs generated POSIX scripts with a fake Magpie executable and service manager.
// It never downloads a release or invokes an installed Magpie.
const git = process.platform === "win32" ? spawnSync("where.exe", ["git"], { encoding: "utf8" }).stdout?.trim().split(/\r?\n/)[0] : undefined;
const bundledBash = git && join(dirname(dirname(git)), "bin", "bash.exe");
const bash = process.env.MIGPIE_BASH || (bundledBash && existsSync(bundledBash) ? bundledBash : "bash");
const directory = await mkdtemp(join(tmpdir(), "migpie-script-smoke-"));
const home = join(directory, "home"), tools = join(directory, "tools");
const run = (script, onStdout) => new Promise((resolveRun, reject) => {
  const setup = `export HOME="$(cd ${shellQuote(home.replaceAll("\\", "/"))} && pwd -P)"\nexport XDG_CONFIG_HOME="$HOME/.config"\nexport PATH="$(cd ${shellQuote(tools.replaceAll("\\", "/"))} && pwd -P):$PATH"\n`;
  const child = spawn(bash, ["-s"], { env: { ...process.env, MSYS_NO_PATHCONV: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const timer = setTimeout(() => { child.kill(); reject(new Error("Script smoke timed out: " + (script.match(/job=[^\n]+/)?.[0] ?? script.slice(-160)))); }, 20000);
  child.stdout.on("data", (chunk) => { stdout += chunk; onStdout?.(chunk.toString()); }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("close", (code) => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
  child.stdin.end(setup + script);
});
const id = "c2be46f1-cf7c-4e27-a5ef-c0786bb4fb05";
try {
  await Promise.all([mkdir(home), mkdir(tools)]);
  const fake = `#!/bin/sh
set -eu
state="$HOME/service-state"
case "$1" in
  --version) printf 'magpie 0.1.1327\\n' ;;
  --help) if [ -f "$HOME/limited-help" ]; then cat "$HOME/limited-help"; else printf '%s\\n' 'magpie update [check]' 'magpie backup [--no-keys] [file]' 'magpie restore [file]' 'magpie healthcheck' 'magpie daemon [install|uninstall|start|stop|restart|status]' 'magpie daemon install [--web] [--addr host:port]' 'magpie daemon web [on|off]'; fi ;;
  backup|restore) printf 'Official encrypted backup commands must not run\\n' >&2; exit 99 ;;
  update) if [ -e "$HOME/fail-update" ]; then printf 'download failed: dial tcp: no such host; isolated-private-output\\n' >&2; exit 1; fi
    if [ -e "$HOME/slow-update" ]; then
      dd if=/dev/zero of="$0.new" bs=1024 count=1 2>/dev/null
      sleep 2
      dd if=/dev/zero bs=1024 count=1 2>/dev/null >> "$0.new"
      sleep 2
      rm -f "$0.new"
    fi
    printf updated > "$HOME/updated" ;;
  healthcheck) if [ -e "$HOME/fail-healthcheck" ]; then printf 'gateway not healthy: isolated-private-output\\n' >&2; exit 1; fi; [ "$(cat "$state" 2>/dev/null)" = running ] ;;
  daemon) printf '%s\\n' "$2" >> "$HOME/service-actions"; if { [ "$2" = restart ] && [ -e "$HOME/fail-restart" ]; } || { [ "$2" = start ] && [ -e "$HOME/fail-start" ]; }; then printf 'permission denied: isolated-private-output\\n' >&2; exit 1; fi; case "$2" in
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
  const config = join(home, ".config", "magpie");
  const backupPath = (backupId, file = "") => join(home, ".config", "magpie-remote", "backups", backupId, file);
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });
  await mkdir(config);
  await writeFile(join(config, "providers.json"), "isolated-config-secret");
  await writeFile(join(home, ".local", "bin", "magpie"), fake, { mode: 0o755 });
  await writeFile(join(home, ".config", "systemd", "user", "magpie.service"), '[Service]\nExecStart="' + binary + '" "serve" "--web=127.0.0.1:3430"\nEnvironment="MAGPIE_WEB_KEY=isolated-script-secret"\n');
  const probe = await run(probeScript); assert.equal(probe.code, 0, probe.stderr);
  const instance = parseProbe(probe.stdout);
  assert.equal(instance.platform, "Linux"); assert.equal(instance.installed, true); assert.equal(instance.web.port, 3430);
  assert.ok(!probe.stdout.includes("isolated-script-secret"));
  assert.equal(instance.version, "magpie 0.1.1327");
  for (const capability of ["update", "backup", "healthcheck", "daemon_start", "daemon_stop", "daemon_restart", "daemon_uninstall", "daemon_web", "daemon_install_web"]) assert.ok(instance.capabilities.includes(capability), "missing " + capability);
  await writeFile(join(home, "limited-help"), 'magpie update [check]\nmagpie daemon\nDescription: backup start stop restart web --addr --web\n');
  const limited = parseProbe((await run(probeScript)).stdout);
  assert.deepEqual(limited.capabilities, ["update"], "Descriptions and a top-level daemon must not imply subcommands");
  await rm(join(home, "limited-help"));
  // Use a canonical HOME for the scripts' explicit default-path ownership check.
  const canonical = 'export HOME=' + "'" + posixHome.replaceAll("'", "'\\''") + "'\n";
  const execute = (action, operationId = randomUUID(), selected, observed = instance) => run(canonical + actionScript(action, observed, operationId, undefined, selected));
  const assertRestoreResult = async (result, operationId, configState, serviceState, rollbackState, recoveryDirectory = instance.configDirectory.replace(/\/magpie$/, "/magpie-remote/backups/") + operationId) => {
    const records = result.stdout.split("\n").filter((line) => /^MIGPIE_(RESULT|RESTORE)_V1\t/.test(line));
    assert.equal(records.length, 2, result.stdout);
    assert.equal(records[0].split("\t").length, 6);
    assert.equal(records[0].split("\t")[0], "MIGPIE_RESULT_V1");
    assert.equal(records[0].split("\t")[1], operationId);
    const restoreFields = records[1].split("\t");
    assert.equal(restoreFields.length, 6);
    assert.deepEqual(restoreFields.slice(0, 5), ["MIGPIE_RESTORE_V1", operationId, configState, serviceState, rollbackState]);
    assert.match(restoreFields[5], /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
    const recovery = Buffer.from(restoreFields[5], "base64").toString("utf8");
    if (recoveryDirectory instanceof RegExp) assert.match(recovery, recoveryDirectory);
    else assert.equal(recovery, recoveryDirectory);
    assert.equal(await readFile(join(home, ".config", "magpie-remote", "operations", operationId, "result"), "utf8"), records.join("\n") + "\n");
    await assert.rejects(access(join(home, ".config", "magpie-remote", "operations", operationId, "output")));
    for (const secret of ["isolated-private-output", "isolated-config-secret", "isolated-script-secret"]) assert.ok(!(result.stdout + result.stderr).includes(secret));
    return recovery;
  };
  const listing = async () => {
    const result = await run(backupInventoryScript);
    assert.equal(result.code, 0, result.stderr);
    return parseBackups(result.stdout, instance.configDirectory);
  };
  await writeFile(join(home, "service-state"), "running");
  const updated = await execute("update", id); assert.equal(updated.code, 0, updated.stderr);
  assert.ok(updated.stdout.includes(`MIGPIE_RESULT_V1\t${id}\tcompleted\t0\tnone\ttrue`));
  assert.equal(await readFile(join(home, "updated"), "utf8"), "updated");
  const contents = await run('tar -xOzf "$HOME/.config/magpie-remote/backups/' + id + '/config.tar.gz" ./providers.json');
  assert.equal(contents.code, 0, contents.stderr); assert.equal(contents.stdout, "isolated-config-secret");
  await assert.rejects(access(backupPath(id, "config.magpie")));
  await rm(join(home, "updated"));
  await writeFile(join(home, "slow-update"), "enabled");
  let liveOutput = "", receivedLiveBytes = false;
  const progressId = randomUUID();
  const slow = await run(canonical + actionScript("update", instance, progressId), (chunk) => {
    liveOutput += chunk;
    if (new RegExp(`MIGPIE_PROGRESS_V1\\t${progressId}\\tupdating\\t(?:1024|2048)\\t0`).test(liveOutput) && !liveOutput.includes("MIGPIE_DONE")) receivedLiveBytes = true;
  });
  assert.equal(slow.code, 0, slow.stderr + slow.stdout);
  assert.equal(receivedLiveBytes, true, "Download size must stream before the update exits");
  assert.ok(slow.stdout.includes(`MIGPIE_PROGRESS_V1\t${progressId}\tupdating\t2048\t0`));
  assert.match(slow.stdout, /\tbacking_up\t0\t0/);
  assert.match(slow.stdout, /\trestarting\t0\t0/);
  await rm(join(home, "slow-update")); await rm(join(home, "updated"));
  await writeFile(join(tools, "tar"), "#!/bin/sh\nprintf 'no space left: isolated-private-output\\n' >&2\nexit 42\n", { mode: 0o755 });
  const failureId = randomUUID(), failed = await execute("update", failureId);
  assert.equal(failed.code, 42); await assert.rejects(access(join(home, "updated")));
  assert.match(failed.stdout, /\tbacking_up\t42\tdisk_full\tfalse/);
  assert.ok(!(failed.stdout + failed.stderr).includes("isolated-private-output"));
  await rm(join(tools, "tar"));
  for (const [flag, step, reason, updatedBeforeFailure] of [
    ["fail-update", "updating", "network", false],
    ["fail-restart", "restarting", "permission", true],
    ["fail-healthcheck", "healthcheck", "command_failed", true],
  ]) {
    const operationId = randomUUID();
    await writeFile(join(home, flag), "fail");
    const result = await execute("update", operationId);
    assert.equal(result.code, 1);
    assert.ok(result.stdout.includes(`MIGPIE_RESULT_V1\t${operationId}\t${step}\t1\t${reason}\ttrue`), result.stdout);
    assert.ok(!(result.stdout + result.stderr).includes("isolated-private-output"));
    assert.equal(await readFile(join(home, ".config", "magpie-remote", "operations", operationId, "result"), "utf8"), result.stdout.split("\n").find((line) => line.startsWith("MIGPIE_RESULT_V1")) + "\n");
    await assert.rejects(access(join(home, ".config", "magpie-remote", "operations", operationId, "output")));
    assert.ok((await readFile(backupPath(operationId, "magpie"))).length);
    if (updatedBeforeFailure) await rm(join(home, "updated"));
    else await assert.rejects(access(join(home, "updated")));
    await rm(join(home, flag));
  }
  const selected = (await listing()).find((backup) => backup.id === id);
  assert.equal(selected.format, "archive"); assert.equal(selected.hasBinary, true); assert.equal(selected.version, instance.version);
  const rejectedRestoreId = randomUUID(), rejectedRestore = await execute("restore", rejectedRestoreId, { ...selected, fingerprint: "0".repeat(64) });
  assert.equal(rejectedRestore.code, 79);
  await assertRestoreResult(rejectedRestore, rejectedRestoreId, "not_applied", "unchanged", "not_needed", "");
  await writeFile(join(config, "providers.json"), "before-restore");
  await writeFile(join(config, "extra.json"), "must-disappear");
  await writeFile(join(home, "service-actions"), "");
  const restoreId = randomUUID(), restored = await execute("restore", restoreId, selected);
  assert.equal(restored.code, 0, restored.stderr + restored.stdout);
  await assertRestoreResult(restored, restoreId, "applied", "running", "not_needed");
  assert.equal(await readFile(join(config, "providers.json"), "utf8"), "isolated-config-secret");
  await assert.rejects(access(join(config, "extra.json")));
  assert.equal(await readFile(join(home, "service-actions"), "utf8"), "stop\nstart\n");
  assert.equal(await readFile(join(home, ".local", "bin", "magpie"), "utf8"), fake);
  const beforeRestore = await run('tar -xOzf "$HOME/.config/magpie-remote/backups/' + restoreId + '/config.tar.gz" ./providers.json');
  assert.equal(beforeRestore.stdout, "before-restore");
  const manualId = randomUUID(), callsBefore = await readFile(join(home, "service-actions"), "utf8");
  const manual = await execute("backup", manualId);
  assert.equal(manual.code, 0, manual.stderr); await assert.rejects(access(join(home, "updated")));
  assert.equal(await readFile(join(home, "service-actions"), "utf8"), callsBefore);
  const manualBackup = (await listing()).find((backup) => backup.id === manualId);
  const tampered = await execute("delete_backup", randomUUID(), { ...manualBackup, fingerprint: "0".repeat(64) });
  assert.notEqual(tampered.code, 0); assert.ok(await readFile(backupPath(manualId, "config.tar.gz")));
  const deleted = await execute("delete_backup", randomUUID(), manualBackup);
  assert.equal(deleted.code, 0, deleted.stderr); await assert.rejects(access(backupPath(manualId)));
  // Invalid and traversal archives must fail before service stop or config replacement.
  for (const invalid of ["corrupt", "traversal"]) {
    const invalidId = randomUUID(); await mkdir(backupPath(invalidId));
    if (invalid === "corrupt") await writeFile(backupPath(invalidId, "config.tar.gz"), "not-an-archive");
    else {
      const result = await run('tar -czPf "$HOME/.config/magpie-remote/backups/' + invalidId + '/config.tar.gz" --transform=\'s|^|../|\' -C "$HOME/.config/magpie" providers.json');
      assert.equal(result.code, 0, result.stderr);
    }
    const invalidBackup = (await listing()).find((backup) => backup.id === invalidId);
    const invalidRestoreId = randomUUID(), result = await execute("restore", invalidRestoreId, invalidBackup);
    assert.notEqual(result.code, 0); assert.match(result.stdout, /\trestoring\t\d+\tcommand_failed\ttrue/);
    await assertRestoreResult(result, invalidRestoreId, "not_applied", "unchanged", "not_needed");
    assert.equal(await readFile(join(config, "providers.json"), "utf8"), "isolated-config-secret");
    assert.equal(await readFile(join(home, "service-actions"), "utf8"), callsBefore);
  }
  // A failed replacement must put the original directory back and retain its snapshot.
  const realMove = (await run("command -v mv")).stdout.trim();
  const failingMove = (failRollback) => `#!/bin/sh
if [ "$#" -eq 3 ] && [ "$1" = -- ]; then
  case "$2" in
    */.magpie-restore.*/config) printf 'permission denied: isolated-private-output\\n' >&2; exit 43 ;;
    ${failRollback ? "*/.magpie-restore.*/previous) printf 'rollback failed: isolated-private-output\\n' >&2; exit 44 ;;" : ""}
  esac
fi
exec ${shellQuote(realMove)} "$@"
`;
  await writeFile(join(tools, "mv"), failingMove(false), { mode: 0o755 });
  await writeFile(join(config, "providers.json"), "before-failed-replacement");
  await writeFile(join(home, "service-actions"), "");
  const rollbackId = randomUUID(), rolledBack = await execute("restore", rollbackId, selected);
  assert.equal(rolledBack.code, 43, rolledBack.stderr + rolledBack.stdout);
  assert.match(rolledBack.stdout, /\trestoring\t43\tpermission\ttrue/);
  await assertRestoreResult(rolledBack, rollbackId, "rolled_back", "stopped", "succeeded");
  assert.equal(await readFile(join(config, "providers.json"), "utf8"), "before-failed-replacement");
  assert.equal(await readFile(join(home, "service-state"), "utf8"), "stopped");
  assert.equal(await readFile(join(home, "service-actions"), "utf8"), "stop\n");
  const rollbackSnapshot = await run('tar -xOzf "$HOME/.config/magpie-remote/backups/' + rollbackId + '/config.tar.gz" ./providers.json');
  assert.equal(rollbackSnapshot.stdout, "before-failed-replacement");
  // If putting previous back also fails, keep it and report its exact recovery path.
  await writeFile(join(tools, "mv"), failingMove(true), { mode: 0o755 });
  await writeFile(join(config, "providers.json"), "before-failed-rollback");
  await writeFile(join(home, "service-state"), "running"); await writeFile(join(home, "service-actions"), "");
  const failedRollbackId = randomUUID(), failedRollback = await execute("restore", failedRollbackId, selected);
  assert.equal(failedRollback.code, 43, failedRollback.stderr + failedRollback.stdout);
  assert.match(failedRollback.stdout, /\trestoring\t43\tpermission\ttrue/);
  const retained = await assertRestoreResult(failedRollback, failedRollbackId, "unknown", "stopped", "failed", /^\/.+\/\.magpie-restore\.[A-Za-z0-9]+\/previous$/);
  await assert.rejects(access(config));
  const retainedConfig = await run('test -d ' + shellQuote(retained) + ' && cat ' + shellQuote(retained + '/providers.json'));
  assert.equal(retainedConfig.code, 0, retainedConfig.stderr); assert.equal(retainedConfig.stdout, "before-failed-rollback");
  const failedRollbackSnapshot = await run('tar -xOzf "$HOME/.config/magpie-remote/backups/' + failedRollbackId + '/config.tar.gz" ./providers.json');
  assert.equal(failedRollbackSnapshot.stdout, "before-failed-rollback");
  assert.equal(await readFile(join(home, "service-state"), "utf8"), "stopped");
  assert.equal(await readFile(join(home, "service-actions"), "utf8"), "stop\n");
  await rm(join(tools, "mv"));
  const recovered = await run('mv -- ' + shellQuote(retained) + ' ' + shellQuote(instance.configDirectory) + ' && rm -rf -- ' + shellQuote(retained.slice(0, -"/previous".length)));
  assert.equal(recovered.code, 0, recovered.stderr);
  // Applied config stays applied when start or healthcheck fails; recovery uses the snapshot.
  for (const [flag, step, reason, expectedService] of [
    ["fail-start", "starting", "permission", "stopped"],
    ["fail-healthcheck", "healthcheck", "command_failed", "running"],
  ]) {
    const operationId = randomUUID(), before = "before-" + flag;
    await writeFile(join(config, "providers.json"), before); await writeFile(join(config, "extra.json"), "must-disappear");
    await writeFile(join(home, "service-state"), "running"); await writeFile(join(home, "service-actions"), "");
    await writeFile(join(home, flag), "fail");
    const result = await execute("restore", operationId, selected);
    assert.equal(result.code, 1, result.stderr + result.stdout);
    assert.ok(result.stdout.includes(`MIGPIE_RESULT_V1\t${operationId}\t${step}\t1\t${reason}\ttrue`), result.stdout);
    await assertRestoreResult(result, operationId, "applied", "unknown", "not_needed");
    assert.equal(await readFile(join(config, "providers.json"), "utf8"), "isolated-config-secret");
    await assert.rejects(access(join(config, "extra.json")));
    assert.equal(await readFile(join(home, "service-state"), "utf8"), expectedService);
    assert.equal(await readFile(join(home, "service-actions"), "utf8"), "stop\nstart\n");
    assert.equal(await readFile(join(home, ".local", "bin", "magpie"), "utf8"), fake);
    const snapshot = await run('tar -xOzf "$HOME/.config/magpie-remote/backups/' + operationId + '/config.tar.gz" ./providers.json');
    assert.equal(snapshot.code, 0, snapshot.stderr); assert.equal(snapshot.stdout, before);
    await rm(join(home, flag));
  }
  await writeFile(join(home, "service-state"), "running");
  console.log("Remote backups: archive-only backups, exact restore, pre-restore snapshots, replacement rollback, retained failed rollback, applied start/healthcheck failures, two-line restore results, binary preservation, corrupt/traversal rejection, fingerprint protection and scoped deletion passed.");
  // Reset completed scenarios before further inventory scans; keep the original for uninstall checks.
  for (const backupId of await readdir(backupPath(""))) {
    if (backupId !== id) await rm(backupPath(backupId), { recursive: true });
  }
  await rm(config, { recursive: true });
  const absentId = randomUUID(), absent = await execute("backup", absentId);
  assert.equal(absent.code, 0, absent.stderr);
  const absentBackup = (await listing()).find((backup) => backup.id === absentId);
  assert.equal(absentBackup.format, "absent");
  await mkdir(config); await writeFile(join(config, "new.json"), "new-config");
  const absentRestore = await execute("restore", randomUUID(), absentBackup);
  assert.equal(absentRestore.code, 0, absentRestore.stderr); await assert.rejects(access(config));
  const legacy = { ...instance, capabilities: instance.capabilities.filter((capability) => !["backup", "restore"].includes(capability)) };
  await mkdir(join(home, "real-config")); await writeFile(join(home, "real-config", "providers.json"), "symlink-config-secret");
  const linked = await run('ln -s "$HOME/real-config" "$HOME/.config/magpie"'); assert.equal(linked.code, 0, linked.stderr);
  // Git Bash may copy directories when native symlinks are unavailable.
  const symlinked = (await run('[ -L "$HOME/.config/magpie" ]')).code === 0;
  const linkedId = randomUUID(), archived = await execute("backup", linkedId, undefined, legacy);
  assert.equal(archived.code, 0, archived.stderr);
  const linkedBackup = (await listing()).find((backup) => backup.id === linkedId);
  await writeFile(join(config, "providers.json"), "changed-linked-config");
  await writeFile(join(home, "service-state"), "stopped"); await writeFile(join(home, "service-actions"), "");
  const linkedRestoreId = randomUUID(), linkedRestore = await execute("restore", linkedRestoreId, linkedBackup, { ...legacy, service: { ...legacy.service, state: "stopped" } });
  assert.equal(linkedRestore.code, 0, linkedRestore.stderr + linkedRestore.stdout);
  await assertRestoreResult(linkedRestore, linkedRestoreId, "applied", "unchanged", "not_needed");
  assert.equal(await readFile(join(config, "providers.json"), "utf8"), "symlink-config-secret");
  assert.equal(await readFile(join(home, "service-actions"), "utf8"), "");
  assert.equal(await readFile(join(home, "service-state"), "utf8"), "stopped");
  const uninstalled = await execute("uninstall", "5d140b01-7a34-432b-ac15-934fba8fc9ae", undefined, { ...instance, binary, managedBinary: binary });
  assert.equal(uninstalled.code, 0, uninstalled.stderr); await assert.rejects(access(join(home, ".local", "bin", "magpie")));
  assert.ok((await readFile(backupPath(id, "config.tar.gz"))).length);
  await writeFile(join(tools, "curl"), '#!/bin/sh\nfor output; do :; done\ncp "$HOME/release-source" "$output"\n', { mode: 0o755 });
  await writeFile(join(home, "release-source"), fake, { mode: 0o755 });
  const release = { version: "0.1.1472", sha256: createHash("sha256").update(fake).digest("hex"), url: "https://github.com/yetone/magpie-releases/releases/download/test/magpie-cli-linux-amd64" };
  const empty = parseProbe((await run(probeScript)).stdout);
  const badInstall = await run(actionScript("install", empty, "2d5d6952-bf60-47ad-b2c7-d4624bcb51dc", { ...release, sha256: "0".repeat(64) }));
  assert.notEqual(badInstall.code, 0); await assert.rejects(access(join(home, ".local", "bin", "magpie")));
  const installed = await run(actionScript("install", empty, "23737f6f-cc09-46d2-85dd-c7ba7965e42c", release));
  assert.equal(installed.code, 0, installed.stderr); assert.equal(await readFile(join(home, ".local", "bin", "magpie"), "utf8"), fake);
  for (const action of ["enable_web", "stop", "start", "restart"]) {
    const observed = parseProbe((await run(probeScript)).stdout), result = await execute(action, randomUUID(), undefined, observed);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(join(home, "service-state"), "utf8"), action === "stop" ? "stopped" : "running");
  }
  const observed = parseProbe((await run(probeScript)).stdout);
  await mkdir(join(home, ".config", "magpie-remote", "operation.lock"));
  const locked = await execute("stop", randomUUID(), undefined, observed);
  assert.equal(locked.code, 75); assert.equal(await readFile(join(home, "service-state"), "utf8"), "running");
  await rm(join(home, ".config", "magpie-remote", "operation.lock"), { recursive: true });
  console.log(`Remote scripts: help capabilities, POSIX probe, checksum install, ${symlinked ? "symlinked" : "directory"}/absent config restore, stopped-service preservation, classified failures without secret output, service actions, lock exclusion and uninstall retaining backups passed.`);
} finally {
  if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith("migpie-script-smoke-")) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
