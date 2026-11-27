import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { libraryOptions, planLibrary, readLocalLibrary, selectLocalLibrary } from "../src/remote-library.mjs";
import { temporary } from "./helpers.mjs";

const windowsServer = { name: "win", transport: "stdio", command: "C:\\work\\serve.cmd", args: ["secret-switch"], env: { KEY: "secret-local" }, agents: ["opencode"], here: { command: "secret-override" } };
const localLibrary = { applied: { claude: "LOCAL" }, projects: [{ path: "C:\\work" }], mcp: [windowsServer, { name: "local", local: true }, { name: "protected", agents: [] }], skills: [{ name: "skill", agents: ["opencode"], offHere: true }], commands: [{ name: "run", agents: [] }] };
const remoteLibrary = {
  applied: { codex: ["remote"], unknown: { value: true } }, projects: [{ path: "/home/remote" }], unknown: [1],
  mcp: [{ name: "remote", header: { KEY: "secret-remote" } }, { name: "win", here: { command: "remote-override" }, env: { KEY: "secret-old" }, agents: ["codex"] }, { name: "protected", local: true }, { name: "local", agents: ["pi"] }],
  skills: [{ name: "skill", agents: ["codex"], offHere: true }, { name: "old", agents: ["pi"] }], commands: [{ name: "remote", agents: ["pi"] }],
};

test("library preview takes any nonempty subset and defaults to merge", () => {
  for (const categories of [["commands"], ["skills", "mcp"], ["instructions", "mcp", "skills", "commands"]]) assert.equal(libraryOptions({ categories }).mode, "merge");
  for (const value of [{}, { categories: [] }, { categories: "skills" }, { categories: ["skills", "skills"] }, { categories: ["unknown"] }, { categories: ["skills"], mode: null }]) {
    assert.throws(() => libraryOptions(value), { code: "REMOTE_LIBRARY_OPTIONS" });
  }
});

test("merge and mirror preserve agent selections, remote applied/projects and host-only settings", () => {
  for (const mode of ["merge", "mirror"]) {
    const plan = planLibrary({ config: localLibrary, entries: new Map(), skipped: new Map() }, { config: remoteLibrary, entries: new Map() }, libraryOptions({ categories: ["mcp", "skills"], mode }));
    assert.deepEqual(plan.config.applied, remoteLibrary.applied);
    assert.deepEqual(plan.config.projects, remoteLibrary.projects);
    assert.deepEqual(plan.config.commands, remoteLibrary.commands);
    assert.deepEqual(plan.config.unknown, [1]);
    assert.deepEqual(plan.config.mcp.find(({ name }) => name === "win"), { ...windowsServer, here: { command: "remote-override" } });
    assert.deepEqual(plan.config.mcp.find(({ name }) => name === "protected"), { name: "protected", local: true });
    assert.deepEqual(plan.config.mcp.find(({ name }) => name === "local"), { name: "local", agents: ["pi"] });
    assert.equal(plan.config.mcp.some(({ name }) => name === "remote"), mode === "merge");
    assert.deepEqual(plan.config.skills[0], { name: "skill", agents: ["opencode"], offHere: true });
    assert.equal(plan.config.skills.some(({ name }) => name === "old"), mode === "merge");
    assert.deepEqual(plan.details.mcp.updated.map(({ name }) => name), ["win"]);
    assert.deepEqual(plan.details.mcp.removed.map(({ name }) => name), mode === "mirror" ? ["remote"] : []);
    assert.deepEqual(plan.warnings.map(({ code, name }) => ({ code, name })), [{ code: "WINDOWS_STDIO_MCP", name: "win" }]);
    assert.doesNotMatch(JSON.stringify([plan.details, plan.warnings]), /secret-|remote-override|work\\/);
  }
});

test("local snapshot skips whole symlinked skills and bounds files before reading", async (t) => {
  const dir = await temporary(t), root = join(dir, "library", "skills");
  await mkdir(join(root, "real"), { recursive: true });
  await writeFile(join(dir, "library.json"), JSON.stringify({ skills: [{ name: "real" }, { name: "linked" }] }));
  await writeFile(join(root, "real", "SKILL.md"), "test skill");
  await symlink(join(root, "real"), join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  const snapshot = await readLocalLibrary(dir, ["skills"]);
  assert.deepEqual([...snapshot.entries.keys()], ["library/skills/real", "library/skills/real/SKILL.md"]);
  assert.equal(snapshot.skipped.get("library/skills/linked"), "local_symlink");
  await truncate(join(root, "real", "SKILL.md"), 20 * 1024 * 1024);
  await assert.rejects(readLocalLibrary(dir, ["skills"]), { code: "REMOTE_LIBRARY_LIMIT" });
});

test("local subset projections reproduce direct fingerprints, including skipped symlinks and raw JSON bytes", async (t) => {
  const dir = await temporary(t), library = join(dir, "library"), skills = join(library, "skills"), sets = join(library, "instruction-sets");
  await mkdir(join(skills, "real"), { recursive: true });
  await mkdir(sets);
  await writeFile(join(dir, "library.json"), '{\n  "instructions": {}, "skills": [], "mcp": [], "commands": []\n}\n');
  await writeFile(join(library, "instructions.md"), "shared");
  await writeFile(join(sets, "套.md"), "set");
  await writeFile(join(skills, "real", "SKILL.md"), "test skill");
  await symlink(join(skills, "real"), join(skills, "linked"), process.platform === "win32" ? "junction" : "dir");
  const categories = ["instructions", "skills", "mcp", "commands"];
  const full = await readLocalLibrary(dir, categories, { includeFiles: false });
  for (let mask = 1; mask < 2 ** categories.length; mask++) {
    const subset = categories.filter((_, index) => mask & (1 << index));
    const projected = selectLocalLibrary(full, subset);
    const direct = await readLocalLibrary(dir, subset);
    assert.equal(projected.fingerprint, direct.fingerprint, subset.join("/"));
    assert.deepEqual(projected.skipped, direct.skipped);
    assert.deepEqual([...projected.entries.keys()].sort(), [...direct.entries.keys()].sort());
  }
});

test("merge keeps remote-only files, while mirror removes only selected groups and protects skipped links", () => {
  const local = {
    config: { instructions: { agents: ["opencode"], sets: [{ id: "new", name: "New" }] }, skills: [{ name: "linked", agents: ["opencode"] }] },
    entries: new Map([["library/instructions.md", { kind: "F", digest: "new" }], ["library/instruction-sets/new.md", { kind: "F", digest: "new" }]]),
    skipped: new Map([["library/skills/linked", "local_symlink"]]),
  };
  const remote = {
    config: { instructions: { agents: ["codex"], sets: [{ id: "old", name: "Old" }] }, skills: [{ name: "linked", agents: ["pi"] }], commands: [{ name: "other" }] },
    entries: new Map([["library/instructions.md", { kind: "F", digest: "old" }], ["library/instruction-sets/old.md", { kind: "F", digest: "old" }], ["library/skills/linked", { kind: "D" }]]),
  };
  for (const mode of ["merge", "mirror"]) {
    const result = planLibrary(local, remote, libraryOptions({ categories: ["instructions", "skills"], mode }));
    assert.equal(result.mutations.has("library/instruction-sets/old.md"), mode === "mirror");
    assert.deepEqual(result.config.instructions, { agents: ["opencode"], sets: [...(mode === "merge" ? remote.config.instructions.sets : []), ...local.config.instructions.sets] });
    assert.deepEqual(result.config.skills, remote.config.skills);
    assert.deepEqual(result.config.commands, remote.config.commands);
    assert.deepEqual(result.details.skills.skipped, [{ name: "linked", kind: "entry", reason: "local_symlink" }]);
    assert.deepEqual(result.details.skills.preserved, result.details.skills.skipped);
    assert.equal(result.mutations.has("library/skills/linked"), false);
  }
});

test("Magpie's empty instruction default does not create a shared instruction change", () => {
  const local = { config: { instructions: { agents: [] } }, entries: new Map(), skipped: new Map() };
  const remote = { config: {}, entries: new Map() };
  for (const mode of ["merge", "mirror"]) {
    const options = libraryOptions({ categories: ["instructions"], mode });
    const plan = planLibrary(local, remote, options);
    assert.deepEqual(plan.counts.instructions, { added: 0, updated: 0, removed: 0, skipped: 0, preserved: 0 });
    assert.equal(plan.configChanged, false);

    const path = "library/instructions.md";
    const withContent = planLibrary({ ...local, entries: new Map([[path, { kind: "F", digest: "content" }]]) }, remote, options);
    assert.equal(withContent.counts.instructions.added, 1);
    assert.equal(withContent.mutations.has(path), true);

    const withAgents = planLibrary({ ...local, config: { instructions: { agents: ["codex"] } } }, remote, options);
    assert.equal(withAgents.counts.instructions.added, 1);
    assert.deepEqual(withAgents.config.instructions, { agents: ["codex"] });
  }
});

test("selected skill and command names reject traversal or absolute paths", () => {
  for (const [category, name] of [["skills", "../outside"], ["skills", "/etc"], ["commands", "C:\\outside"], ["commands", ".."]]) {
    assert.throws(() => planLibrary({ config: { [category]: [{ name }] }, entries: new Map(), skipped: new Map() }, { config: {}, entries: new Map() }, libraryOptions({ categories: [category] })), { code: "REMOTE_LIBRARY_PATH" });
  }
});

test("Magpie stdio overrides use shared as the portable start and preserve the remote start", () => {
  const local = { config: { mcp: [
    { name: "share", transport: "stdio", command: "C:\\local.cmd", args: ["local-machine-only"], env: { TOKEN: "local-machine-secret" }, agents: ["opencode"], shared: { command: "node", args: ["portable.js"], env: { TOKEN: "portable-secret" } } },
    { name: "new", transport: "stdio", command: "pwsh", shared: { command: "npx" }, agents: [] },
    { name: "conflict", transport: "http", url: "https://example.com" },
  ] }, entries: new Map(), skipped: new Map() };
  const destination = { name: "share", transport: "stdio", command: "/usr/bin/remote", env: { LOCAL: "remote-machine-secret" }, shared: { command: "old" }, agents: ["codex"] };
  const conflict = { ...destination, name: "conflict" };
  const remote = { config: { mcp: [destination, conflict] }, entries: new Map() };
  const result = planLibrary(local, remote, libraryOptions({ categories: ["mcp"], mode: "mirror" }));
  assert.deepEqual(result.config.mcp, [
    { ...destination, agents: ["opencode"], shared: local.config.mcp[0].shared },
    conflict,
    { name: "new", transport: "stdio", command: "npx", agents: [] },
  ]);
  assert.equal(result.details.mcp.skipped[0].reason, "remote_here_transport_conflict");
  assert.deepEqual(result.warnings, []);
  assert.doesNotMatch(JSON.stringify(result.details), /machine-secret|portable-secret|portable\.js/);
});

test("host-linked instruction sets keep the remote counterpart and never activate a missing local link", () => {
  const local = { config: { instructions: { active: "linked", agents: ["opencode"], sets: [{ id: "linked", name: "Local", file: "C:\\local.md" }] } }, entries: new Map(), skipped: new Map() };
  const remoteSet = { id: "linked", name: "Remote", file: "/local/remote.md" };
  const remote = { config: { instructions: { active: "linked", agents: ["pi"], sets: [remoteSet] } }, entries: new Map([["library/instruction-sets/linked.md", { kind: "F", digest: "remote" }]]) };
  const mirror = libraryOptions({ categories: ["instructions"], mode: "mirror" });
  const result = planLibrary(local, remote, mirror);
  assert.deepEqual(result.config.instructions, { active: "linked", agents: ["opencode"], sets: [remoteSet] });
  assert.equal(result.details.instructions.skipped[0].reason, "local_instruction_file");
  assert.equal(result.mutations.size, 0);
  const fresh = planLibrary(local, { config: {}, entries: new Map() }, mirror);
  assert.equal(fresh.config.instructions.active, undefined);
  assert.deepEqual(fresh.config.instructions.sets, []);
});
