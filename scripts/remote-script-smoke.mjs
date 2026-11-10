import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, rmdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { actionScript, probeScript, recoveryScript, scriptCommand, shellQuote } from "../src/remote-scripts.mjs";
import { parseProbe } from "../src/remote.mjs";
import { backupInventoryScript, parseBackups } from "../src/remote-backups.mjs";
import { listenerScopeFunction } from "../src/remote-listeners.mjs";
import { createServer } from "node:http";
import { networkProbeScript, parseNetwork } from "../src/lan-detection.mjs";
import { remoteHTTP, remoteHTTPScript, remoteProviderAPI } from "../src/remote-http.mjs";
import { forwardConflictScript, parseForwardConflict } from "../src/forward-conflicts.mjs";

// Runs generated POSIX scripts with a fake Magpie executable and service manager.
// It never downloads a release or invokes an installed Magpie.
const git = process.platform === "win32" ? spawnSync("where.exe", ["git"], { encoding: "utf8" }).stdout?.trim().split(/\r?\n/)[0] : undefined;
const bundledBash = git && join(dirname(dirname(git)), "bin", "bash.exe");
const bash = process.env.MIGPIE_BASH || (bundledBash && existsSync(bundledBash) ? bundledBash : "bash");
const directory = await mkdtemp(join(tmpdir(), "migpie-script-smoke-"));
const home = join(directory, "home"), tools = join(directory, "tools");
const run = async (script, onStdout, input = "") => {
  const setup = `export HOME="$(cd ${shellQuote(home.replaceAll("\\", "/"))} && pwd -P)"\nexport XDG_CONFIG_HOME="$HOME/.config"\nunset MAGPIE_ADDR\nexport PATH="$(cd ${shellQuote(tools.replaceAll("\\", "/"))} && pwd -P):$HOME/.local/bin:/usr/bin:/bin:/mingw64/bin"\n`;
  const path = join(directory, "script-" + randomUUID() + ".sh");
   const isolated = script.replaceAll("/proc/net/tcp6", home.replaceAll("\\", "/") + "/tcp6").replaceAll("/proc/net/tcp", home.replaceAll("\\", "/") + "/tcp");
   await writeFile(path, setup + (input ? "exec " + scriptCommand(isolated) + "\n" : isolated));
  try { return await new Promise((resolveRun, reject) => {
  const child = spawn(bash, [path.replaceAll("\\", "/")], { env: { ...process.env, MSYS_NO_PATHCONV: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const timer = setTimeout(() => { child.kill(); reject(new Error("Script smoke timed out: " + (script.match(/job=[^\n]+/)?.[0] ?? script.slice(-160)))); }, 20000);
  child.stdout.on("data", (chunk) => { stdout += chunk; onStdout?.(chunk.toString()); }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("close", (code) => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
  child.stdin.on("error", () => {});
  if (input instanceof Readable) input.pipe(child.stdin); else child.stdin.end(input);
  }); } finally { await rm(path, { force: true }); }
};
const id = "c2be46f1-cf7c-4e27-a5ef-c0786bb4fb05";
try {
  await Promise.all([mkdir(home), mkdir(tools)]);
  // Exercise the generated inspection script with both tools, hidden process
  // details, empty results and tool failures, without inspecting the host.
  const fakeTool = (name, body) => writeFile(join(tools, name), "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
  await fakeTool("ss", `test "$*" = '-H -ltnpe sport = :3425' || exit 2
printf '%s\\n' 'LISTEN 0 128 127.0.0.1:3425 0.0.0.0:* users:(("node",pid=1234,fd=8)) uid:1000 ino:42' 'LISTEN 0 128 127.0.0.1:3426 0.0.0.0:* users:(("other",pid=9999,fd=9))'`);
  await fakeTool("ps", `test "$*" = '-p 1234 -o pid= -o user= -o comm=' || exit 2
printf ' 1234 alice node\\n'`);
  await fakeTool("id", `test "$*" = '-nu 1000' || exit 2
printf 'alice\\n'`);
  let inspected = await run(forwardConflictScript(3425));
  assert.equal(inspected.code, 0, inspected.stderr);
  let conflict = parseForwardConflict(inspected.stdout, 3425);
  assert.equal(conflict.listeners.length, 1);
  assert.equal(conflict.listeners[0].processes[0].name, "node");
  assert.equal(conflict.listeners[0].processes[0].user, "alice");
  assert.ok(!inspected.stdout.includes("9999"));
  await fakeTool("ss", `printf '%s\\n' 'LISTEN 0 128 [::]:3425 [::]:* uid:1000 ino:42'`);
  conflict = parseForwardConflict((await run(forwardConflictScript(3425))).stdout, 3425);
  assert.equal(conflict.listeners[0].address, "[::]:3425");
  assert.equal(conflict.listeners[0].user, "alice");
  assert.deepEqual(conflict.listeners[0].processes, []);
  await fakeTool("ss", "exit 0");
  assert.deepEqual(parseForwardConflict((await run(forwardConflictScript(3425))).stdout, 3425).listeners, []);
  await fakeTool("ss", "exit 2");
  await fakeTool("lsof", `test "$*" = '-nP -a -iTCP:3425 -sTCP:LISTEN -FpcuLfn' || exit 2
printf 'p1234\\ncnode\\nu1000\\nLalice\\nf8\\nn[::1]:3425\\n'`);
  conflict = parseForwardConflict((await run(forwardConflictScript(3425))).stdout, 3425);
  assert.equal(conflict.listeners[0].address, "[::1]:3425");
  assert.equal(conflict.listeners[0].processes[0].user, "alice");
  await fakeTool("lsof", "exit 1");
  assert.deepEqual(parseForwardConflict((await run(forwardConflictScript(3425))).stdout, 3425).listeners, []);
  await fakeTool("lsof", "printf 'private failure details\\n' >&2\nexit 1");
  inspected = await run(forwardConflictScript(3425));
  assert.equal(parseForwardConflict(inspected.stdout, 3425).available, false);
  assert.ok(!inspected.stdout.includes("private failure details"));
  await Promise.all(["ss", "ps", "id", "lsof"].map((name) => rm(join(tools, name))));
  console.log("Forward conflicts: POSIX ss/lsof scripts, exact port filtering, process/user lookup, hidden owners, empty results and unavailable tools passed.");
  const requests = [], httpKey = "script-fixture-web-key-123456789";
  const httpServer = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ path: request.url, headers: request.headers, body });
      if (request.url === "/?k=" + httpKey) {
        response.writeHead(303, { Location: "/must-not-follow", "Set-Cookie": "magpie_web_fixture=" + httpKey + "; HttpOnly; Path=/" }).end();
      } else if (request.url === "/redirect") response.writeHead(302, { Location: "/must-not-follow" }).end();
      else if (request.url === "/denied") response.writeHead(401).end("private-error-output");
      else if (request.url === "/api/providers" || request.url === "/api/provider/save") {
        assert.equal(request.headers.cookie, "magpie_web_fixture=" + httpKey);
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ providers: [], ...(body && { saved: JSON.parse(body) }) }));
      } else response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    })().catch(() => { response.writeHead(500).end(); });
  });
  await new Promise((done) => httpServer.listen(0, "127.0.0.1", done));
  try {
    const address = "http://127.0.0.1:" + httpServer.address().port;
    await writeFile(join(home, ".curlrc"), 'location\nheader = "X-From-Curlrc: unsafe"\n');
    const noProxy = 'export http_proxy=http://127.0.0.1:1 https_proxy=http://127.0.0.1:1 ALL_PROXY=http://127.0.0.1:1 NO_PROXY= no_proxy=\n';
    const executed = [];
    const httpSessions = { async execute(_id, command, { input }) {
      assert.equal(command, "sh -s"); executed.push(command);
      const reply = await run(noProxy + input);
      assert.ok([0, 22].includes(reply.code), "Isolated curl exited " + reply.code + ": " + reply.stderr);
      return reply;
    } };
    const credential = "fixture-'\"\\$()`-shared-key", body = { name: "本机 𠮷 ' \" \\ \n", key: credential };
    assert.equal((await remoteHTTP(httpSessions, "fixture", address + "/echo", { method: "POST", headers: { Authorization: "Bearer " + credential }, body })).status, 200);
    assert.equal(requests.at(-1).headers.authorization, "Bearer " + credential);
    assert.deepEqual(JSON.parse(requests.at(-1).body), body);
    assert.equal((await remoteHTTP(httpSessions, "fixture", address + "/redirect")).status, 302);
    await assert.rejects(remoteHTTP(httpSessions, "fixture", address + "/denied"), { code: "PROVIDER_LINK_HTTP" });
    const denied = await run(noProxy + remoteHTTPScript(address + "/denied"));
    assert.equal(denied.code, 22); assert.equal(denied.stderr, ""); assert.ok(!denied.stdout.includes("private-error-output"));
    const api = await remoteProviderAPI(httpSessions, "fixture", { url: address + "/?k=" + httpKey });
    assert.deepEqual(await api("/api/providers"), { providers: [] });
    assert.deepEqual((await api("/api/provider/save", body)).saved, body);
    assert.ok(requests.every((request) => request.path !== "/must-not-follow" && !request.headers["x-from-curlrc"]));
    assert.ok(executed.every((command) => !command.includes(credential) && !command.includes(httpKey)));
  } finally {
    httpServer.closeAllConnections(); await new Promise((done) => httpServer.close(done));
    await rm(join(home, ".curlrc"));
  }
  await writeFile(join(tools, "ip"), "#!/bin/sh\ncase \"$1\" in -4) printf '%s dev eth0 src 192.168.10.3\\n' \"$4\";; -6) printf '%s dev eth1 src fd12::3\\n' \"$4\";; *) exit 2;; esac\n", { mode: 0o755 });
  const hosts = ["192.168.10.2", "fd12::2"];
  const networkReply = await run("export SSH_CONNECTION='192.168.10.2 1234 192.168.10.3 22'\n" + networkProbeScript(hosts));
  assert.equal(networkReply.code, 0, networkReply.stderr);
  const network = parseNetwork(networkReply.stdout, hosts);
  assert.equal(network.curl, true); assert.deepEqual(network.ssh, ["192.168.10.2", "1234", "192.168.10.3", "22"]);
  assert.equal(network.routes.get(hosts[0]), "192.168.10.2 dev eth0 src 192.168.10.3");
  assert.equal(network.routes.get(hosts[1]), "fd12::2 dev eth1 src fd12::3");
  await rm(join(tools, "ip"));
  console.log("LAN scripts: POSIX IPv4/IPv6 network evidence and actual curl authentication, JSON escaping, proxy/curlrc bypass, no redirects and SSH-stdin credentials passed.");
  const fake = `#!/bin/sh
set -eu
state="$HOME/service-state"
case "$1" in
  --version) printf 'magpie 0.1.1327\\n' ;;
  --help) if [ -f "$HOME/limited-help" ]; then cat "$HOME/limited-help"; else printf '%s\\n' 'magpie update [check]' 'magpie backup [--no-keys] [file]' 'magpie restore [file]' 'magpie healthcheck' 'magpie daemon [install|uninstall|start|stop|restart|status]' 'magpie daemon install [--web] [--addr host:port]' 'magpie daemon web [on|off]'; fi ;;
  backup|restore) printf 'Official encrypted backup commands must not run\\n' >&2; exit 99 ;;
  update) if [ -e "$HOME/fail-update" ]; then printf 'download failed: dial tcp: no such host; isolated-private-output\\n' >&2; exit 1; fi
    if [ -e "$HOME/interrupt-download" ]; then
      # Let the progress loop enter its wait before signalling the parent shell.
      sleep 1
      kill -HUP "$PPID"
      sleep 1
      if [ -d "$HOME/.config/magpie-remote/operation.lock" ]; then printf kept > "$HOME/interrupted-child-lock"; else printf missing > "$HOME/interrupted-child-lock"; fi
      exit 0
    fi
    if [ -e "$HOME/slow-update" ]; then
      dd if=/dev/zero of="$0.new" bs=1024 count=1 2>/dev/null
      sleep 2
      dd if=/dev/zero bs=1024 count=1 2>/dev/null >> "$0.new"
      sleep 2
      rm -f "$0.new"
    fi
    printf updated > "$HOME/updated" ;;
  healthcheck) [ "$MAGPIE_ADDR" = 127.0.0.1:3425 ] || exit 97; if [ -e "$HOME/fail-healthcheck" ]; then printf 'gateway not healthy: isolated-private-output\\n' >&2; exit 1; fi; [ "$(cat "$state" 2>/dev/null)" = running ] ;;
  daemon) printf '%s\\n' "$2" >> "$HOME/service-actions"; if { [ "$2" = restart ] && [ -e "$HOME/fail-restart" ]; } || { [ "$2" = start ] && [ -e "$HOME/fail-start" ]; }; then printf 'permission denied: isolated-private-output\\n' >&2; exit 1; fi; case "$2" in
    install) mkdir -p "$HOME/.config/systemd/user"
      printf '[Service]\nExecStart="%s" serve "--web=127.0.0.1:3430"\nEnvironment="MAGPIE_ADDR=%s"\nEnvironment="MAGPIE_WEB_KEY=isolated-script-secret"\n' "$0" "$MAGPIE_ADDR" > "$HOME/.config/systemd/user/magpie.service"
      printf running > "$state" ;;
    restart|start) printf running > "$state" ;;
    stop) printf stopped > "$state" ;;
    uninstall) rm -f "$HOME/.config/systemd/user/magpie.service" "$state" ;;
    *) exit 3 ;;
  esac ;;
  *) exit 4 ;;
esac
`;
  await writeFile(join(tools, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
  await writeFile(join(tools, "systemctl"), `#!/bin/sh
case "$*" in
  *show-environment*) exit 0;;
  *UnitPath*) printf '%s' "$HOME/.config/systemd/user";;
  *ActiveState*) if [ "$(cat "$HOME/service-state" 2>/dev/null)" = running ]; then printf active; else printf inactive; fi;;
  *FragmentPath*) if [ -f "$HOME/.config/systemd/user/magpie.service" ]; then printf '%s' "$HOME/.config/systemd/user/magpie.service"; else exit 1; fi;;
  *DropInPaths*) if [ -f "$HOME/drop-in" ]; then printf '%s' "$HOME/override.conf"; fi;;
  *EnvironmentFiles*) if [ -f "$HOME/env-file" ]; then printf '%s' "$HOME/service.env"; fi;;
  *NeedDaemonReload*) printf no;;
  *LoadState*) if [ -f "$HOME/.config/systemd/user/magpie.service" ]; then printf loaded; else printf not-found; exit 1; fi;;
  *'stop magpie.service'*) printf stopped > "$HOME/service-state";;
esac
`, { mode: 0o755 });
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
  const unitPath = join(home, ".config", "systemd", "user", "magpie.service");
  const safeUnit = '[Service]\nExecStart="' + binary + '" serve "--web=127.0.0.1:3430"\nEnvironment="MAGPIE_ADDR=127.0.0.1:3425"\nEnvironment="MAGPIE_WEB_KEY=isolated-script-secret"\n';
  await writeFile(unitPath, safeUnit);
  const tcpRow = (address, port = 3425) => `0: ${address}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A\n`;
  const safeListeners = tcpRow("0100007F") + tcpRow("0100007F", 3430);
  await writeFile(join(home, "tcp"), safeListeners); await writeFile(join(home, "tcp6"), "");
  await writeFile(join(home, "service-state"), "running");
  const probe = await run(probeScript); assert.equal(probe.code, 0, probe.stderr);
  const instance = parseProbe(probe.stdout);
  assert.equal(instance.platform, "Linux"); assert.equal(instance.installed, true); assert.equal(instance.web.port, 3430);
  assert.ok(!probe.stdout.includes("isolated-script-secret"));
  assert.equal(instance.version, "magpie 0.1.1327");
  assert.equal(instance.service.scope, "loopback", JSON.stringify(instance.service));
  assert.equal(instance.service.rebuildSafe, true);
  for (const capability of ["update", "backup", "healthcheck", "daemon_start", "daemon_stop", "daemon_restart", "daemon_uninstall", "daemon_web", "daemon_install_web"]) assert.ok(instance.capabilities.includes(capability), "missing " + capability);
  await writeFile(join(home, "limited-help"), 'magpie update [check]\nmagpie daemon\nDescription: backup start stop restart web --addr --web\n');
  const limited = parseProbe((await run(probeScript)).stdout);
  assert.deepEqual(limited.capabilities, ["update"], "Descriptions and a top-level daemon must not imply subcommands");
  await rm(join(home, "limited-help"));
  // Use a canonical HOME for the scripts' explicit default-path ownership check.
  const canonical = 'export HOME=' + "'" + posixHome.replaceAll("'", "'\\''") + "'\n";
  const release = { version: "0.1.1327", sha256: createHash("sha256").update(fake).digest("hex"), size: Buffer.byteLength(fake) };
  const execute = (action, operationId = randomUUID(), selected, observed = instance) => run(canonical + actionScript(action, observed, operationId, release, selected), undefined, ["install", "update"].includes(action) ? fake : "");
  // Exercise the actual POSIX parser with IPv4, IPv6 and mixed socket tables.
  for (const [ipv4, ipv6, scope] of [
    [tcpRow("0100007F"), "", "loopback"],
    [tcpRow("0200007F"), "", "loopback"],
    [tcpRow("00000000"), "", "exposed"],
    [tcpRow("0101A8C0"), "", "exposed"],
    ["", tcpRow("00000000000000000000000001000000"), "loopback"],
    ["", tcpRow("00000000000000000000000000000000"), "exposed"],
    ["", tcpRow("0000000000000000FFFF00000100007F"), "loopback"],
    [tcpRow("0100007F"), tcpRow("00000000000000000000000000000000"), "exposed"],
    [tcpRow("0100007F", 3426), "", "unknown"],
  ]) {
    await writeFile(join(home, "tcp"), ipv4); await writeFile(join(home, "tcp6"), ipv6);
    const checked = await run(listenerScopeFunction + "listener_scope 3425\n");
    assert.equal(checked.code, 0, checked.stderr); assert.equal(checked.stdout.trim(), scope);
  }
  await writeFile(join(tools, "od"), "#!/bin/sh\ncat >/dev/null\nprintf '256\\n'\n", { mode: 0o755 });
  for (const [ipv4, ipv6, scope] of [
    [tcpRow("7F000001"), "", "loopback"],
    [tcpRow("C000007F"), "", "exposed"],
    ["", tcpRow("00000000000000000000000000000001"), "loopback"],
    ["", tcpRow("00000000000000000000FFFF7F000001"), "loopback"],
  ]) {
    await writeFile(join(home, "tcp"), ipv4); await writeFile(join(home, "tcp6"), ipv6);
    const checked = await run(listenerScopeFunction + "listener_scope 3425\n");
    assert.equal(checked.stdout.trim(), scope, checked.stderr);
  }
  await rm(join(tools, "od"));
  await rm(join(home, "tcp")); await rm(join(home, "tcp6"));
  for (const [addresses, scope] of [["127.0.0.1:3425", "loopback"], ["[::1]:3425", "loopback"], ["[::]:3425", "exposed"], ["0.0.0.0:3425", "exposed"], ["127.0.0.1:3426", "unknown"]]) {
    await writeFile(join(tools, "ss"), "#!/bin/sh\nprintf '%s\\n' 'LISTEN 0 128 " + addresses + " *:*'\n", { mode: 0o755 });
    const checked = await run(listenerScopeFunction + "listener_scope 3425\n");
    assert.equal(checked.stdout.trim(), scope, checked.stderr);
  }
  await rm(join(tools, "ss"));
  await writeFile(join(home, "tcp"), safeListeners); await writeFile(join(home, "tcp6"), "");
  for (const unsafe of [
    safeUnit.replace("MAGPIE_ADDR=127.0.0.1", "MAGPIE_ADDR=0.0.0.0"),
    safeUnit.replace("MAGPIE_ADDR=127.0.0.1", "MAGPIE_ADDR=[::]"),
    safeUnit.replace("--web=127.0.0.1", "--web=0.0.0.0"),
    safeUnit.replace("--web=127.0.0.1", "--web=[::]"),
    safeUnit.replace('Environment="MAGPIE_ADDR=127.0.0.1:3425"\n', ""),
    safeUnit + 'EnvironmentFile=/some/override.env\n',
    safeUnit.replace('serve "--web', 'serve --lan "--web'),
  ]) {
    await writeFile(unitPath, unsafe); await writeFile(join(home, "service-actions"), "");
    const observed = parseProbe((await run(probeScript)).stdout);
    assert.equal(observed.service.scope, "unknown");
    for (const action of ["start", "restart", "update"]) {
      const result = await execute(action, randomUUID(), undefined, observed);
      assert.equal(result.code, 80, result.stderr + result.stdout);
      assert.match(result.stdout, /\tverifying\t80\tloopback_required\tfalse/);
    }
    assert.equal(await readFile(join(home, "service-actions"), "utf8"), "");
  }
  await writeFile(unitPath, safeUnit);
  for (const flag of ["drop-in", "env-file"]) {
    await writeFile(join(home, flag), "override");
    const observed = parseProbe((await run(probeScript)).stdout);
    assert.equal(observed.service.rebuildSafe, false);
    const result = await execute("enable_web", randomUUID(), undefined, observed);
    assert.equal(result.code, 80, result.stderr + result.stdout);
    assert.equal(await readFile(join(home, "service-actions"), "utf8"), "");
    await rm(join(home, flag));
  }
  const genericDropin = join(home, ".config", "systemd", "user", "service.d");
  await mkdir(genericDropin);
  await writeFile(join(genericDropin, "override.conf"), '[Service]\nEnvironment="MAGPIE_ADDR=0.0.0.0:3425"\n');
  const overridden = parseProbe((await run(probeScript)).stdout);
  assert.equal(overridden.service.rebuildSafe, false, "Unloaded generic drop-ins must also be detected");
  assert.equal((await execute("enable_web", randomUUID(), undefined, overridden)).code, 80);
  await rm(genericDropin, { recursive: true });
  for (const scope of ["exposed", "unknown"]) {
    await writeFile(join(home, "tcp"), scope === "exposed" ? tcpRow("00000000") + tcpRow("0100007F", 3430) : "");
    const result = await execute("start", randomUUID());
    assert.equal(result.code, 80, result.stderr + result.stdout);
    assert.match(result.stdout, /\tstarting\t80\tloopback_required\tfalse/);
    assert.equal(await readFile(join(home, "service-state"), "utf8"), "stopped", "Unverified service must be stopped");
  }
  await writeFile(join(home, "tcp"), safeListeners);
  await writeFile(unitPath, safeUnit.replace("MAGPIE_ADDR=127.0.0.1", "MAGPIE_ADDR=0.0.0.0"));
  const rebuilt = await execute("enable_web", randomUUID(), undefined, parseProbe((await run(probeScript)).stdout));
  assert.equal(rebuilt.code, 0, rebuilt.stderr + rebuilt.stdout);
  assert.equal((await readFile(unitPath, "utf8")), safeUnit);
  console.log("Remote privacy: IPv4/IPv6 socket inspection, ss fallback, public gateway/Web refusal, unsafe unit and systemd override refusal, post-start shutdown and loopback service rebuilding passed.");
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
  await assert.rejects(access(join(home, "updated")), "Native update must never run");
  const contents = await run('tar -xOzf "$HOME/.config/magpie-remote/backups/' + id + '/config.tar.gz" ./providers.json');
  assert.equal(contents.code, 0, contents.stderr); assert.equal(contents.stdout, "isolated-config-secret");
  await assert.rejects(access(backupPath(id, "config.magpie")));
  let liveOutput = "", receivedLiveUpload = false;
  const progressId = randomUUID();
  const slowInput = Readable.from((async function* () { yield Buffer.from(fake.slice(0, 32)); await delay(1000); yield Buffer.from(fake.slice(32)); })());
  const slow = await run(canonical + actionScript("update", instance, progressId, release), (chunk) => {
    liveOutput += chunk;
    if (liveOutput.includes(`MIGPIE_PROGRESS_V1\t${progressId}\tuploading\t0\t0`) && !liveOutput.includes("MIGPIE_DONE")) receivedLiveUpload = true;
  }, slowInput);
  assert.equal(slow.code, 0, slow.stderr + slow.stdout);
  assert.equal(receivedLiveUpload, true, "The upload stage must stream before installation completes");
  assert.match(slow.stdout, /\tbacking_up\t0\t0/);
  assert.match(slow.stdout, /\trestarting\t0\t0/);
  await writeFile(join(tools, "tar"), "#!/bin/sh\nprintf 'no space left: isolated-private-output\\n' >&2\nexit 42\n", { mode: 0o755 });
  const failureId = randomUUID(), failed = await execute("update", failureId);
  assert.equal(failed.code, 42); await assert.rejects(access(join(home, "updated")));
  assert.match(failed.stdout, /\tbacking_up\t42\tdisk_full\tfalse/);
  assert.ok(!(failed.stdout + failed.stderr).includes("isolated-private-output"));
  await rm(join(tools, "tar"));
  for (const [flag, step, reason] of [
    ["fail-restart", "restarting", "permission"],
    ["fail-healthcheck", "healthcheck", "command_failed"],
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
    await assert.rejects(access(join(home, "updated")));
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
  await writeFile(join(tools, "curl"), '#!/bin/sh\nprintf "Remote network must not be used\\n" >&2\nexit 99\n', { mode: 0o755 });
  const empty = parseProbe((await run(probeScript)).stdout);
  const badInstall = await run(actionScript("install", empty, "2d5d6952-bf60-47ad-b2c7-d4624bcb51dc", { ...release, sha256: "0".repeat(64) }), undefined, fake);
  assert.notEqual(badInstall.code, 0); await assert.rejects(access(join(home, ".local", "bin", "magpie")));
  const truncated = await run(actionScript("install", empty, randomUUID(), release), undefined, fake.slice(0, 50));
  assert.notEqual(truncated.code, 0); await assert.rejects(access(join(home, ".local", "bin", "magpie")));
  const installed = await run(actionScript("install", empty, "23737f6f-cc09-46d2-85dd-c7ba7965e42c", release), undefined, fake);
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
  const recoveryId = randomUUID(), lockPath = join(home, ".config", "magpie-remote", "operation.lock");
  const legacyRecovery = await run(recoveryScript(recoveryId));
  assert.equal(legacyRecovery.code, 0, legacyRecovery.stderr);
  assert.equal(legacyRecovery.stdout.trim(), `MIGPIE_RECOVERED_V1\t${recoveryId}`);
  await assert.rejects(access(lockPath));
  assert.equal((await run(recoveryScript(recoveryId))).code, 0, "Recovery without a residual lock must be retryable");
  await mkdir(lockPath); await writeFile(join(lockPath, "unexpected"), "keep");
  assert.notEqual((await run(recoveryScript(recoveryId))).code, 0);
  assert.equal(await readFile(join(lockPath, "unexpected"), "utf8"), "keep");
  await rm(join(lockPath, "unexpected"));
  const foreignOwner = randomUUID() + ":99999999";
  await writeFile(join(lockPath, "owner"), foreignOwner);
  assert.equal((await run(recoveryScript(recoveryId))).code, 75);
  assert.equal(await readFile(join(lockPath, "owner"), "utf8"), foreignOwner);
  const liveOwner = await run(`printf '%s:%s' '${recoveryId}' "$$" > "$HOME/.config/magpie-remote/operation.lock/owner"\n` + recoveryScript(recoveryId));
  assert.equal(liveOwner.code, 75, "A live process must keep its lock");
  assert.ok(await readFile(join(lockPath, "owner"), "utf8"));
  await writeFile(join(lockPath, "owner"), recoveryId + ":not-a-pid");
  assert.equal((await run(recoveryScript(recoveryId))).code, 78);
  await writeFile(join(lockPath, "owner"), recoveryId + ":99999999");
  assert.equal((await run(recoveryScript(recoveryId))).code, 0);
  await assert.rejects(access(lockPath));
  const recoveryLock = join(home, ".config", "magpie-remote", "recovery.lock");
  await mkdir(recoveryLock); await writeFile(join(recoveryLock, "owner"), "99999999");
  assert.equal((await run(recoveryScript(recoveryId))).code, 0, "A crashed recovery must not leave another permanent lock");
  await assert.rejects(access(recoveryLock));
  await mkdir(join(home, ".config", "magpie-remote", "recovery.lock"));
  assert.equal((await execute("stop")).code, 75, "A recovery guard must exclude deployments");
  await rmdir(join(home, ".config", "magpie-remote", "recovery.lock"));
  // Trigger HUP/TERM/PIPE in the actual generated shell after it owns the lock.
  // The exit trap must persist a failure and release both the lock and its owner.
  for (const [signal, code] of [["HUP", 129], ["INT", 130], ["TERM", 143], ["PIPE", 141]]) {
    const operationId = randomUUID();
    const interrupted = await run(actionScript("stop", observed, operationId).replace('set_step verifying\n', () => `kill -${signal} $$\nset_step verifying\n`));
    assert.equal(interrupted.code, code, interrupted.stderr + interrupted.stdout);
    assert.match(interrupted.stdout, new RegExp(`MIGPIE_RESULT_V1\\t${operationId}\\tpreparing\\t${code}\\tcommand_failed\\tfalse`));
    assert.equal(await readFile(join(home, ".config", "magpie-remote", "operations", operationId, "state"), "utf8"), "failed");
    await assert.rejects(access(lockPath));
  }
  const interruptedDownloadId = randomUUID();
  const interruptedDownload = await run(actionScript("update", observed, interruptedDownloadId, release).replace("run_step uploading receive_binary", () => "set_step uploading\nkill -HUP $$\nrun_step uploading receive_binary"), undefined, fake);
  assert.equal(interruptedDownload.code, 129, interruptedDownload.stderr + interruptedDownload.stdout);
  assert.match(interruptedDownload.stdout, new RegExp(`MIGPIE_RESULT_V1\\t${interruptedDownloadId}\\tuploading\\t129\\tcommand_failed\\tfalse`));
  await assert.rejects(access(lockPath));
  console.log("Remote recovery: legacy/dead-owner locks, live/foreign-owner refusal, unexpected-file preservation, recovery exclusion, stale recovery retry and HUP/INT/TERM/PIPE failure persistence including interrupted uploads passed.");
  console.log(`Remote scripts: help capabilities, POSIX probe, checksum install, ${symlinked ? "symlinked" : "directory"}/absent config restore, stopped-service preservation, classified failures without secret output, service actions, lock exclusion and uninstall retaining backups passed.`);
} finally {
  if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith("migpie-script-smoke-")) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
