import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative as relativePath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { OperationError } from "./errors.mjs";

export const libraryAction = "library_sync";
export const libraryCategories = ["instructions", "skills", "mcp", "commands"];
export const libraryModes = ["merge", "mirror"];
export const libraryTools = ["sha256sum", "base64", "mktemp", "tar", "readlink"];
export const libraryLimits = { json: 4 * 1024 * 1024, file: 16 * 1024 * 1024, bytes: 64 * 1024 * 1024, entries: 4096, depth: 32, path: 1024 };
const sharedInstructions = "library/instructions.md";
const treeRoots = { instructions: "library/instruction-sets", skills: "library/skills" };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const libraryHash = (value) => createHash("sha256").update(value).digest("hex");

export function libraryOptions({ categories, mode = "merge" } = {}) {
  if (!Array.isArray(categories) || !categories.length || categories.length > libraryCategories.length || new Set(categories).size !== categories.length
    || [...categories].some((category) => !libraryCategories.includes(category)) || !libraryModes.includes(mode)) {
    throw new OperationError("REMOTE_LIBRARY_OPTIONS", "请选择至少一个资源库分类，且同步策略须为 merge 或 mirror");
  }
  return { categories: libraryCategories.filter((category) => categories.includes(category)), mode };
}

export function libraryLimitError() {
  return new OperationError("REMOTE_LIBRARY_LIMIT", "资源库超过大小或数量上限。配置最多 4 MiB，单个文件最多 16 MiB，文件总计最多 64 MiB，最多 4096 个条目，路径最多 1024 字节和 32 层");
}

export function libraryPathError() {
  return new OperationError("REMOTE_LIBRARY_PATH", "资源库包含不安全的路径、符号链接根目录或不支持的文件类型，无法安全同步");
}

const invalid = () => new OperationError("REMOTE_LIBRARY_INVALID", "资源库 library.json 格式无效或包含重复条目");
const changed = () => new OperationError("REMOTE_PREVIEW_STALE", "读取时资源库发生变化，请重新预览");
const sameFile = (a, b) => a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

function safePart(part) {
  return Boolean(part && part !== "." && part !== ".." && !/[\\/:\x00-\x1f\x7f]/u.test(part) && Buffer.byteLength(part) <= 255);
}

export function resourcePath(path) {
  if (path === sharedInstructions) return { category: "instructions", group: path, name: "shared" };
  if (typeof path !== "string" || Buffer.byteLength(path) > libraryLimits.path) return;
  const parts = path.split("/");
  if (parts.length < 3 || parts.length > libraryLimits.depth + 2 || parts[0] !== "library" || !parts.slice(2).every(safePart)) return;
  const category = parts[1] === "skills" ? "skills" : parts[1] === "instruction-sets" ? "instructions" : undefined;
  if (category) return { category, group: parts.slice(0, 3).join("/"), name: parts[2] };
}

export function parseLibraryJSON(bytes) {
  let config;
  try { config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
  if (!object(config)) throw invalid();
  const stack = [[config, 0]];
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (depth > 64) throw libraryLimitError();
    for (const child of Object.values(value)) if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
  }
  return config;
}

async function info(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function readRegular(path, before, max) {
  if (!before.isFile()) throw libraryPathError();
  if (before.size > max) throw libraryLimitError();
  if (relativePath(path, await realpath(path))) throw changed();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(before, await file.stat())) throw changed();
    const bytes = Buffer.alloc(before.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset);
      if (!bytesRead) throw changed();
      offset += bytesRead;
    }
    if (!sameFile(before, await file.stat()) || !sameFile(before, await lstat(path))) throw changed();
    return bytes;
  } finally { await file.close(); }
}

export async function readLocalLibrary(directory, categories, { includeFiles = true, signal } = {}) {
  if (!directory) throw new OperationError("REMOTE_LIBRARY_LOCAL_UNAVAILABLE", "未配置本机 Magpie 数据目录");
  function checkCancelled() {
    if (signal?.aborted) throw new OperationError("REMOTE_CANCELLED", "资源库预览已取消");
  }
  try {
    checkCancelled();
    const rootDirectory = await realpath(directory).catch((error) => {
      if (error.code === "ENOENT") throw new OperationError("REMOTE_LIBRARY_LOCAL_UNAVAILABLE", "未找到本机 Magpie 数据目录");
      throw error;
    });
    const configPath = join(rootDirectory, "library.json"), configInfo = await info(configPath);
    if (!configInfo) throw new OperationError("REMOTE_LIBRARY_LOCAL_UNAVAILABLE", "本机 Magpie 数据目录中没有 library.json，请先在本机打开资源库");
    const bytes = await readRegular(configPath, configInfo, libraryLimits.json);
    const config = parseLibraryJSON(bytes), entries = new Map(), skipped = new Map();
    let count = 0, total = 0;
    const library = join(rootDirectory, "library");
    const readGroups = categories.includes("instructions") || categories.includes("skills");
    const libraryInfo = readGroups && await info(library);
    if (libraryInfo && !libraryInfo.isDirectory()) throw libraryPathError();

    async function walk(path, relative, groupEntries, before = undefined) {
      checkCancelled();
      if (++count > libraryLimits.entries) throw libraryLimitError();
      if (!resourcePath(relative)) throw libraryPathError();
      before ??= await lstat(path);
      if (before.isSymbolicLink()) return false;
      if (before.isDirectory()) {
        if (relativePath(path, await realpath(path))) throw changed();
        groupEntries.set(relative, { kind: "D" });
        const children = await opendir(path);
        for await (const child of children) {
          if (!await walk(join(path, child.name), relative + "/" + child.name, groupEntries)) return false;
        }
        const after = await lstat(path);
        if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw changed();
      } else {
        total += before.size;
        if (total > libraryLimits.bytes) throw libraryLimitError();
        const content = await readRegular(path, before, libraryLimits.file);
        groupEntries.set(relative, { kind: before.mode & 0o111 ? "X" : "F", digest: libraryHash(content), ...(includeFiles && { content }) });
      }
      return true;
    }

    async function group(path, relative, before) {
      const members = new Map();
      if (await walk(path, relative, members, before)) for (const entry of members) entries.set(...entry);
      else skipped.set(relative, "local_symlink");
    }

    if (libraryInfo) {
      if (categories.includes("instructions")) {
        const path = join(library, "instructions.md"), before = await info(path);
        if (before) {
          if (before.isDirectory()) throw libraryPathError();
          await group(path, sharedInstructions, before);
        }
      }
      for (const category of categories) {
        if (!Object.hasOwn(treeRoots, category)) continue;
        const root = join(rootDirectory, treeRoots[category]), before = await info(root);
        if (!before) continue;
        if (!before.isDirectory()) throw libraryPathError();
        if (relativePath(root, await realpath(root))) throw changed();
        const children = await opendir(root);
        for await (const child of children) await group(join(root, child.name), treeRoots[category] + "/" + child.name);
        const after = await lstat(root);
        if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw changed();
      }
      const after = await lstat(library);
      if (!after.isDirectory() || libraryInfo.dev !== after.dev || libraryInfo.ino !== after.ino || libraryInfo.mtimeMs !== after.mtimeMs || libraryInfo.ctimeMs !== after.ctimeMs) throw changed();
    }
    if (!sameFile(configInfo, await lstat(configPath))) throw changed();
    checkCancelled();
    return localSnapshot({ config, configDigest: libraryHash(bytes), entries, skipped });
  } catch (error) {
    if (error instanceof OperationError) throw error;
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) throw changed();
    throw new OperationError("REMOTE_LIBRARY_LOCAL_READ_FAILED", "读取本机资源库失败，请检查目录与文件权限");
  }
}

function byName([a], [b]) { return a < b ? -1 : a > b ? 1 : 0; }

function localSnapshot(snapshot) {
  const { configDigest, entries, skipped } = snapshot;
  const files = [...entries].sort(byName).map(([path, { kind, digest }]) => [path, kind, digest]);
  return { ...snapshot, fingerprint: libraryHash(JSON.stringify([configDigest, files, [...skipped].sort(byName)])) };
}

export function selectLibraryResources(resources, categories) {
  return new Map([...resources].filter(([path]) => categories.includes(resourcePath(path)?.category)));
}

export function selectLocalLibrary(snapshot, categories) {
  return localSnapshot({ ...snapshot, entries: selectLibraryResources(snapshot.entries, categories), skipped: selectLibraryResources(snapshot.skipped, categories) });
}

function namedItems(value, category, key = "name") {
  if (value == null) return new Map();
  if (!Array.isArray(value)) throw invalid();
  if (value.length > libraryLimits.entries) throw libraryLimitError();
  const entries = new Map();
  for (const item of value) {
    if (!object(item) || typeof item[key] !== "string" || !item[key] || Buffer.byteLength(item[key]) > 255 || /[\x00-\x1f\x7f]/u.test(item[key]) || entries.has(item[key])) throw invalid();
    if (category !== "mcp" && !safePart(item[key])) throw libraryPathError();
    entries.set(item[key], item);
  }
  return entries;
}

function portableItem(item, current, fields) {
  const result = { ...item };
  for (const field of ["applied", "projects", ...fields]) {
    delete result[field];
    if (current && Object.hasOwn(current, field)) result[field] = current[field];
  }
  return result;
}

function stdioStart(item) {
  const start = item.shared ?? item;
  if (!object(start)) throw invalid();
  const { command, args, env } = start;
  return { ...(command !== undefined && { command }), ...(args !== undefined && { args }), ...(env !== undefined && { env }) };
}

function stdio(item) { return item.transport === "stdio" || (!item.transport && Boolean(item.command)); }

function portableMcp(item, current) {
  const result = portableItem(item, current, ["here", "local"]);
  const start = stdio(item) && stdioStart(item);
  delete result.shared;
  if (!start) return result;
  for (const key of ["command", "args", "env"]) delete result[key];
  if (current?.shared != null) {
    const { shared: _shared, ...effective } = current;
    Object.assign(result, stdioStart(effective), { shared: start });
  } else Object.assign(result, start);
  return result;
}

function portableSkill(item, current) {
  const result = portableItem(item, current, ["offHere", "here", "home"]);
  if (object(item.source) && Object.hasOwn(item.source, "dir")) {
    const { dir: _dir, ...portable } = item.source;
    if (current?.source?.dir && current.source.kind === portable.kind) portable.dir = current.source.dir;
    if (!portable.dir && !portable.repo) delete result.source;
    else result.source = portable;
  }
  return result;
}

const windowsToken = /(?:[a-z]:[\\/]|\\|\.(?:exe|cmd|bat|ps1)(?:$|\s|["'])|(?:^|[\s"'/])(?:cmd|powershell|pwsh)(?:$|[\s"'])|%(?:USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|SystemRoot)%)/iu;

function projected(name, item = {}, kind = "entry") {
  const summary = { name, kind };
  const env = item.shared?.env ?? item.env;
  const headers = object(item.headers) ? item.headers : item.header;
  if (object(env)) summary.envCount = Object.keys(env).length;
  if (object(headers)) summary.headerCount = Object.keys(headers).length;
  return summary;
}

function groupEntries(entries) {
  const groups = new Map();
  for (const [path, entry] of [...entries].sort(byName)) {
    const resource = resourcePath(path);
    if (!resource) throw libraryPathError();
    if (!groups.has(resource.group)) groups.set(resource.group, new Map());
    groups.get(resource.group).set(path, entry);
  }
  return groups;
}

const treeDigest = (entries) => entries && [...entries].map(([path, { kind, digest }]) => [path, kind, digest]);

// Magpie writes this default even when the shared instructions have never been configured.
const emptyInstructions = (value) => value == null || isDeepStrictEqual(value, {}) || isDeepStrictEqual(value, { agents: [] });

export function planLibrary(local, remote, options) {
  const config = { ...remote.config }, details = {}, warnings = [], mutations = new Map();
  const before = groupEntries(remote.entries), after = groupEntries(local.entries);
  const mirror = options.mode === "mirror";

  for (const category of options.categories) {
    const added = [], updated = [], removed = [], skipped = [], preserved = [];
    details[category] = { added, updated, removed, skipped, preserved };

    function change(name, old, next, oldFiles, newFiles, kind = "entry") {
      if (isDeepStrictEqual(old, next) && isDeepStrictEqual(treeDigest(oldFiles), treeDigest(newFiles))) return;
      if (old === undefined && !oldFiles) added.push(projected(name, next, kind));
      else if (next === undefined && !newFiles) removed.push(projected(name, old, kind));
      else updated.push(projected(name, next, kind));
    }

    function files(path) {
      const old = before.get(path), next = after.get(path) ?? (mirror ? undefined : old);
      if (!isDeepStrictEqual(treeDigest(old), treeDigest(next))) mutations.set(path, next);
      return [old, next];
    }

    const roots = [...new Set([...before.keys(), ...after.keys(), ...local.skipped.keys()])].filter((path) => resourcePath(path)?.category === category);
    if (category === "instructions") {
      const source = local.config.instructions, current = config.instructions;
      if ((source != null && !object(source)) || (current != null && !object(current))) throw invalid();
      const { sets: sourceSets, ...shared } = source ?? {}, { sets: currentSets, ...oldShared } = current ?? {};
      const sourceItems = namedItems(sourceSets, category, "id"), currentItems = namedItems(currentSets, category, "id");
      const result = new Map(currentItems);
      const accounted = new Set([sharedInstructions]);
      for (const id of new Set([...currentItems.keys(), ...sourceItems.keys()])) {
        const path = treeRoots.instructions + "/" + id + ".md", item = sourceItems.get(id), old = currentItems.get(id);
        accounted.add(path);
        // Magpie reads <id>.md for portable sets and treats file as a link
        // to a machine-local document.
        const reason = item?.file ? "local_instruction_file" : local.skipped.get(path);
        if (reason) {
          skipped.push({ name: id, kind: "instruction_set", reason });
          if (old || before.has(path)) preserved.push({ name: id, kind: "instruction_set", reason });
          continue;
        }
        if (item) {
          result.set(id, portableItem(item, old, ["file", "here", "offHere"]));
          if (old?.file) preserved.push({ name: id, kind: "instruction_set", reason: "remote_instruction_file" });
        } else if (mirror) result.delete(id);
        change(id, old, result.get(id), ...files(path), "instruction_set");
      }
      const sharedSkipped = local.skipped.get(sharedInstructions);
      const nextShared = sharedSkipped ? oldShared : source != null ? portableItem(shared, oldShared, ["file", "here", "offHere"]) : mirror ? {} : oldShared;
      if (nextShared.active && !result.has(nextShared.active)) {
        if (result.has(oldShared.active)) nextShared.active = oldShared.active;
        else delete nextShared.active;
      }
      if (sharedSkipped) {
        skipped.push({ name: "shared", kind: "shared_instructions", reason: sharedSkipped });
        if (current || before.has(sharedInstructions)) preserved.push({ name: "shared", kind: "shared_instructions", reason: sharedSkipped });
      }
      else {
        const defaultsOnly = emptyInstructions(oldShared) && emptyInstructions(nextShared);
        change("shared", defaultsOnly || current == null ? undefined : oldShared,
          defaultsOnly || (source == null && mirror) ? undefined : nextShared, ...files(sharedInstructions), "shared_instructions");
      }
      const next = { ...nextShared };
      if (result.size || Array.isArray(sourceSets) || Array.isArray(currentSets)) next.sets = [...result.values()];
      if (!(emptyInstructions(current) && emptyInstructions(next)) && !isDeepStrictEqual(current, next)) config.instructions = next;
      for (const path of roots) {
        if (accounted.has(path)) continue;
        const { name } = resourcePath(path), reason = local.skipped.get(path);
        if (reason) {
          skipped.push({ name, kind: "instruction_set_file", reason });
          if (before.has(path)) preserved.push({ name, kind: "instruction_set_file", reason });
        }
        else change(name, undefined, undefined, ...files(path), "instruction_set_file");
      }
      continue;
    }

    const source = namedItems(local.config[category], category), current = namedItems(config[category], category), next = new Map(current);
    const names = new Set([...current.keys(), ...source.keys(), ...roots.map((path) => resourcePath(path).name)]);
    for (const name of names) {
      const incoming = source.get(name), old = current.get(name);
      const path = category === "skills" ? treeRoots.skills + "/" + name : undefined;
      const reason = path ? local.skipped.get(path) : category === "mcp" && incoming?.local === true ? "local_mcp"
        : category === "mcp" && incoming && old?.shared != null && !stdio(incoming) ? "remote_here_transport_conflict" : undefined;
      if (category === "mcp" && old?.local === true) {
        if (incoming) skipped.push({ ...projected(name, incoming), reason: "remote_local_mcp" });
        preserved.push({ ...projected(name, old), reason: "remote_local_mcp" });
        continue;
      }
      if (reason) {
        skipped.push({ ...projected(name, incoming), reason });
        if (old || (path && before.has(path))) preserved.push({ ...projected(name, old), reason });
        continue;
      }
      if (incoming) {
        next.set(name, category === "mcp" ? portableMcp(incoming, old) : category === "skills" ? portableSkill(incoming, old) : portableItem(incoming, old, ["taken", "here", "offHere"]));
        if (category === "mcp" && (Object.hasOwn(old ?? {}, "here") || old?.shared != null)) preserved.push({ ...projected(name, old), reason: "remote_here" });
        if (category === "skills" && Object.hasOwn(old ?? {}, "offHere")) preserved.push({ name, kind: "entry", reason: "remote_off_here" });
        if (category === "mcp" && stdio(incoming)) {
          const { command, args, env } = stdioStart(incoming);
          if ([command, ...(Array.isArray(args) ? args : []), ...(object(env) ? Object.values(env) : [])].some((token) => typeof token === "string" && windowsToken.test(token))) {
            warnings.push({ code: "WINDOWS_STDIO_MCP", category, name, message: "此 stdio MCP 使用疑似 Windows 路径或命令，Linux 上可能需要配置本机启动方式。" });
          }
        }
      } else if (mirror) next.delete(name);
      change(name, old, next.get(name), ...(path ? files(path) : [undefined, undefined]));
    }
    if (!isDeepStrictEqual([...current], [...next])) config[category] = [...next.values()];
  }
  const counts = Object.fromEntries(Object.entries(details).map(([category, detail]) => [category, Object.fromEntries(Object.entries(detail).map(([key, items]) => [key, items.length]))]));
  return { config, configChanged: !isDeepStrictEqual(config, remote.config), mutations, details, counts, warnings };
}
