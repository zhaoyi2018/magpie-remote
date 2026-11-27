import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { actionScript, probeScript, scriptCommand, shellQuote } from "../src/remote-scripts.mjs";
import { libraryHash, libraryOptions, planLibrary, readLocalLibrary } from "../src/remote-library.mjs";
import { libraryBundle, librarySnapshotScript, parseLibrarySnapshot } from "../src/remote-library-transfer.mjs";
import { parseProbe } from "../src/remote.mjs";
import { temporary } from "./helpers.mjs";

const git = process.platform === "win32" ? spawnSync("where.exe", ["git"], { encoding: "utf8" }).stdout?.trim().split(/\r?\n/)[0] : undefined;
const shell = process.env.MIGPIE_BASH || (git ? join(dirname(dirname(git)), "bin", "sh.exe") : "sh");

async function fixture(t, syncOutput = "printf 'library written into OpenCode\n'") {
  const directory = await temporary(t), home = join(directory, "home"), tools = join(directory, "tools"), local = join(directory, "local");
  const config = join(home, ".config", "magpie"), bin = join(tools, "magpie");
  await Promise.all([mkdir(config, { recursive: true }), mkdir(local), mkdir(tools)]);
  const tool = (name, script) => writeFile(join(tools, name), "#!/bin/sh\n" + script + "\n", { mode: 0o755 });
  await tool("uname", "case \"$1\" in -s) echo Linux ;; -m) echo x86_64 ;; esac");
  await tool("magpie", `case "$*" in
  --version) echo 'magpie 0.1.4794' ;;
  'library help') echo '  magpie library sync    write it into the agents again' ;;
  ls) echo '  OpenCode     fixture' ;;
  'library sync')
    cp "$XDG_CONFIG_HOME/magpie/library.json" "$HOME/activated.json"
    ${syncOutput} ;;
esac`);
  const shPath = (path) => path.replaceAll("\\", "/");
  const toShell = (path) => process.platform === "win32" ? shPath(path).replace(/^([A-Z]):/i, (_, drive) => "/" + drive.toLowerCase()) : path;
  const setup = `export HOME=${shellQuote(toShell(home))}\nexport XDG_CONFIG_HOME="$HOME/.config"\nexport PATH=${shellQuote(toShell(tools))}:"$PATH"\n`;
  async function run(script, input) {
    const file = join(directory, randomUUID() + ".sh");
    await writeFile(file, setup + (input === undefined ? script : "exec " + scriptCommand(script) + "\n"));
    return new Promise((resolve, reject) => {
      const child = spawn(shell, [shPath(file)], { env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS: "winsymlinks:nativestrict" }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8"); child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.setEncoding("utf8"); child.stderr.on("data", (data) => { stderr += data; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.on("error", () => {});
      if (input === undefined || Buffer.isBuffer(input)) child.stdin.end(input);
      else input.pipe(child.stdin);
    });
  }
  return { local, config, home, bin, run, toShell, tool };
}

test("POSIX library action snapshots, checksums, mirrors selected directories, backs up, and activates", async (t) => {
  const { local, config, home, run, toShell, bin } = await fixture(t);
  const options = libraryOptions({ categories: ["instructions", "skills", "mcp"], mode: "mirror" });
  const original = { applied: { codex: { test: true } }, projects: [{ path: "/srv/project" }], skills: [{ name: "old" }], commands: [{ name: "unchanged" }], mcp: [{ name: "host", local: true }] };
  const incoming = { applied: { local: true }, projects: [], instructions: { agents: ["opencode"] }, skills: [{ name: "fresh", agents: ["opencode"], offHere: true }], mcp: [{ name: "shared", transport: "stdio", command: "C:\\serve.cmd", env: { KEY: "FIXTURE_SECRET" }, agents: [] }] };
  await Promise.all([mkdir(join(local, "library", "skills", "fresh", "子目录"), { recursive: true }), mkdir(join(config, "library", "skills", "old"), { recursive: true })]);
  await writeFile(join(local, "library", "skills", "fresh", "子目录", "file with spaces.txt"), Buffer.from([0, 9, 255]));
  await writeFile(join(local, "library", "instructions.md"), "Shared instructions");
  await writeFile(join(config, "library", "skills", "old", "SKILL.md"), "old skill");
  await writeFile(join(config, "library.json"), JSON.stringify(original));
  await writeFile(join(local, "library.json"), JSON.stringify(incoming));
  const probe = parseProbe((await run(probeScript)).stdout);
  assert.ok(probe.capabilities.includes("library_sync"));
  const instance = { ...probe, binary: toShell(bin), configDirectory: toShell(config) };
  const snapshot = await run(librarySnapshotScript(instance, options.categories));
  assert.equal(snapshot.code, 0, snapshot.stderr);
  const remote = parseLibrarySnapshot(snapshot.stdout, options.categories);
  const localSnapshot = await readLocalLibrary(local, options.categories);
  const plan = planLibrary(localSnapshot, remote, options), bundle = libraryBundle(plan);
  assert.equal(plan.warnings[0].code, "WINDOWS_STDIO_MCP");
  const wrong = await run(actionScript("library_sync", instance, randomUUID(), undefined, undefined, { ...bundle, sha256: libraryHash("wrong"), remote, options }), bundle.stream());
  assert.equal(wrong.code, 84);
  assert.equal(JSON.parse(await readFile(join(config, "library.json"))).skills[0].name, "old");
  const id = randomUUID();
  const result = await run(actionScript("library_sync", instance, id, undefined, undefined, { ...bundle, remote, options }), bundle.stream());
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`MIGPIE_LIBRARY_RESULT_V1\\t${id}\\tapplied\\tsynced`));
  assert.doesNotMatch(result.stdout + result.stderr, /FIXTURE_SECRET/);
  const activated = JSON.parse(await readFile(join(home, "activated.json")));
  assert.deepEqual(activated.applied, original.applied);
  assert.deepEqual(activated.projects, original.projects);
  assert.deepEqual(activated.commands, original.commands);
  assert.deepEqual(activated.skills, [{ name: "fresh", agents: ["opencode"] }]);
  assert.deepEqual(activated.mcp, [...original.mcp, incoming.mcp[0]]);
  assert.equal(await readFile(join(config, "library", "instructions.md"), "utf8"), "Shared instructions");
  assert.deepEqual(await readFile(join(config, "library", "skills", "fresh", "子目录", "file with spaces.txt")), Buffer.from([0, 9, 255]));
  await assert.rejects(readFile(join(config, "library", "skills", "old", "SKILL.md")), { code: "ENOENT" });
  assert.ok((await readFile(join(dirname(config), "magpie-remote", "backups", id, "config.tar.gz"))).length > 0);
});

test("POSIX library action rejects stale content and refuses symlink roots", async (t) => {
  const { local, config, run, toShell, bin } = await fixture(t);
  const options = libraryOptions({ categories: ["skills"] });
  const instance = { binary: toShell(bin), configDirectory: toShell(config), version: "0.1.4794", capabilities: ["library_sync"] };
  await writeFile(join(local, "library.json"), JSON.stringify({ skills: [{ name: "scheduled" }] }));
  const source = await readLocalLibrary(local, options.categories);
  const remote = parseLibrarySnapshot((await run(librarySnapshotScript(instance, options.categories))).stdout, options.categories);
  const bundle = libraryBundle(planLibrary(source, remote, options));
  const locked = await run('mkdir -p "$XDG_CONFIG_HOME/magpie-remote/operation.lock"');
  assert.equal(locked.code, 0);
  const busy = await run(actionScript("library_sync", instance, randomUUID(), undefined, undefined, { ...bundle, remote, options }), bundle.stream());
  assert.equal(busy.code, 75);
  assert.match(busy.stdout, /MIGPIE_LOCKED/);
  const unlocked = await run('rmdir "$XDG_CONFIG_HOME/magpie-remote/operation.lock"');
  assert.equal(unlocked.code, 0);
  await writeFile(join(config, "library.json"), JSON.stringify({ applied: { unexpectedly: "updated" } }));
  const result = await run(actionScript("library_sync", instance, randomUUID(), undefined, undefined, { ...bundle, remote, options }), bundle.stream());
  assert.equal(result.code, 82);
  assert.match(result.stdout, /\tstale_library\tfalse/);
  await symlink(local, join(config, "library"), process.platform === "win32" ? "junction" : "dir");
  const unsafe = await run(librarySnapshotScript(instance, options.categories));
  assert.equal(unsafe.code, 78);
});

test("POSIX rollback restores moved groups, and activation failure keeps a recoverable backup without raw output", async (t) => {
  const { local, config, home, run, toShell, bin, tool } = await fixture(t, "printf 'FIXTURE_CREDENTIAL stdout\\n'; printf 'FIXTURE_CREDENTIAL stderr\\n' >&2; exit 2");
  const instance = { binary: toShell(bin), configDirectory: toShell(config), version: "0.1.4794", capabilities: ["library_sync"] };
  const options = libraryOptions({ categories: ["skills"] });
  const relative = ["library", "skills", "same", "SKILL.md"];
  for (const [root, contents] of [[local, "new"], [config, "old"]]) {
    await mkdir(dirname(join(root, ...relative)), { recursive: true });
    await writeFile(join(root, ...relative), contents);
    await writeFile(join(root, "library.json"), JSON.stringify({ skills: [{ name: "same", agents: [contents] }] }));
  }
  const source = await readLocalLibrary(local, options.categories);
  const remote = parseLibrarySnapshot((await run(librarySnapshotScript(instance, options.categories))).stdout, options.categories);
  const bundle = libraryBundle(planLibrary(source, remote, options));
  const action = (id) => actionScript("library_sync", instance, id, undefined, undefined, { ...bundle, remote, options });
  await tool("mv", `last=''; for arg do last=$arg; done
case "$last" in */magpie/library.json) if [ "$1" = -Tf ] && [ -f "$HOME/fail-rename" ]; then exit 1; fi ;; esac
exec /usr/bin/mv "$@"`);
  await writeFile(join(home, "fail-rename"), "");
  const rejected = await run(action(randomUUID()), bundle.stream());
  assert.equal(rejected.code, 1, rejected.stdout);
  assert.match(rejected.stdout, /\trolled_back\tnot_started/);
  assert.equal(await readFile(join(config, ...relative), "utf8"), "old");
  assert.deepEqual(JSON.parse(await readFile(join(config, "library.json"))).skills[0].agents, ["old"]);
  await run('rm -- "$HOME/fail-rename"');
  const id = randomUUID();
  const failed = await run(action(id), bundle.stream());
  assert.equal(failed.code, 2, failed.stdout);
  assert.match(failed.stdout, /\tlibrary_sync_failed\ttrue/);
  assert.match(failed.stdout, /\tapplied\tfailed/);
  assert.equal(await readFile(join(config, ...relative), "utf8"), "new");
  const remoteBase = join(dirname(config), "magpie-remote");
  const result = await readFile(join(remoteBase, "operations", id, "result"), "utf8");
  assert.doesNotMatch(failed.stdout + failed.stderr + result, /FIXTURE_CREDENTIAL/);
  const backedUp = await run(`tar -xOzf "$XDG_CONFIG_HOME/magpie-remote/backups/${id}/config.tar.gz" ./library.json`);
  assert.deepEqual(JSON.parse(backedUp.stdout).skills[0].agents, ["old"]);
});
