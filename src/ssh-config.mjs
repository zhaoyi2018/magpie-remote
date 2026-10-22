import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { text, validateForward, validateProfile } from "./config.mjs";

const repeated = new Set(["identityfile", "localforward", "remoteforward"]);
const mapped = new Set(["hostname", "user", "port", "identityfile", "identityagent", "userknownhostsfile", "localforward", "remoteforward", "gatewayports", "clearallforwardings"]);
const blocked = new Set(["proxyjump", "proxycommand", "hostkeyalias", "certificatefile", "pkcs11provider", "securitykeyprovider", "knownhostscommand", "revokedhostkeys"]);

function tokens(value) {
  const result = [];
  let token = "", quote = "", started = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\" && /[\\\s"'#]/.test(value[i + 1] ?? "")) { token += value[++i]; started = true; }
    else if (quote) { if (c === quote) quote = ""; else token += c; }
    else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (c === "#") break;
    else if (/\s/.test(c)) { if (started) result.push(token); token = ""; started = false; }
    else { token += c; started = true; }
  }
  if (quote) throw new Error("引号未闭合");
  if (started) result.push(token);
  return result;
}

function matches(value, patterns) {
  let positive = false;
  for (const pattern of patterns) {
    const negative = pattern.startsWith("!");
    const body = negative ? pattern.slice(1) : pattern;
    const expression = body.split("").map((c) => c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
    if (new RegExp(`^${expression}$`).test(value)) {
      if (negative) return false;
      positive = true;
    }
  }
  return positive;
}

function expand(value, context) {
  const expanded = value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    if (!Object.hasOwn(context.env, name)) throw new Error(`环境变量 ${name} 未设置`);
    return context.env[name];
  }).replace(/%([%a-zA-Z])/g, (_, key) => {
    if (key === "%") return "%";
    if (!Object.hasOwn(context, key)) throw new Error(`不支持路径替换符 %${key}`);
    return context[key];
  });
  if (expanded === "~") return context.d;
  if (/^~[\\/]/.test(expanded)) return join(context.d, expanded.slice(2));
  if (expanded.startsWith("~")) throw new Error("暂不支持其他用户的 ~ 路径");
  return expanded;
}

async function includeFiles(pattern) {
  const wildcard = pattern.search(/[*?[]/);
  if (wildcard === -1) return [pattern];
  // Walk only the path components named by Include; do not recurse over a home directory.
  const prefixEnd = Math.max(pattern.lastIndexOf("/", wildcard), pattern.lastIndexOf("\\", wildcard));
  let parents = [pattern.slice(0, prefixEnd + 1)];
  for (const component of pattern.slice(prefixEnd + 1).split(/[\\/]/)) {
    const next = [];
    for (const parent of parents) {
      if (!/[*?[]/.test(component)) { next.push(join(parent, component)); continue; }
      let expression = "";
      for (let i = 0; i < component.length; i++) {
        const c = component[i];
        if (c === "*") expression += ".*";
        else if (c === "?") expression += ".";
        else if (c === "[" && component.indexOf("]", i + 1) > i + 1) {
          const end = component.indexOf("]", i + 1);
          expression += "[" + component.slice(i + 1, end).replace(/^!/, "^") + "]"; i = end;
        } else expression += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      let entries;
      try { entries = await readdir(parent); } catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") continue; throw error; }
      for (const name of entries.sort()) {
        if (name.startsWith(".") && !component.startsWith(".")) continue;
        if (new RegExp(`^${expression}$`).test(name)) next.push(join(parent, name));
        if (next.length > 128) throw new Error("Include 匹配文件过多，请缩小范围");
      }
    }
    parents = next;
  }
  return parents;
}

function networkAddress(value, listener = false, gateway = false) {
  let host, port;
  const address = /^\[([^\]]+)\]:(\d+)$/.exec(value) ?? /^([^:]*):(\d+)$/.exec(value);
  if (address) [, host, port] = address;
  else if (listener && /^\d+$/.test(value)) { host = gateway ? "0.0.0.0" : "127.0.0.1"; port = value; }
  else throw new Error("仅支持 TCP 端口转发，不支持 Unix socket 或动态转发");
  if (host === "*" || host === "") host = "0.0.0.0";
  if (listener && host === "localhost") host = "127.0.0.1";
  return { host, port: Number(port) };
}

function matchCondition(args, alias, values, context) {
  if (args.length === 1 && args[0].toLowerCase() === "all") return true;
  let unknown = false, rejected = false;
  for (let i = 0; i < args.length; i++) {
    const negative = args[i].startsWith("!");
    const key = args[i].replace(/^!/, "").toLowerCase();
    if (["all", "canonical", "final"].includes(key)) { unknown = true; continue; }
    const pattern = args[++i];
    const value = { host: values.get("hostname")?.[0]?.replace(/%h/g, alias) ?? alias, originalhost: alias, user: values.get("user")?.[0] ?? context.u, localuser: context.u }[key];
    if (!pattern || value === undefined) { unknown = true; continue; }
    const result = matches(value, pattern.split(","));
    if (negative ? result : !result) rejected = true;
  }
  return rejected ? false : unknown ? null : true;
}

/** Read configuration as data only. Never invoke ssh -G: Match exec may execute commands. */
export async function readSSHConfig({ configPath, home = homedir(), systemPath, username = userInfo().username, env = process.env } = {}) {
  const system = systemPath ?? (process.platform === "win32" ? join(env.ProgramData ?? "C:\\ProgramData", "ssh", "ssh_config") : "/etc/ssh/ssh_config");
  const context = { d: home, u: username, L: hostname().split(".")[0], l: hostname(), env };
  const roots = configPath ? [{ path: expand(text(configPath, "配置文件路径"), context), base: join(home, ".ssh") }]
    : [{ path: join(home, ".ssh", "config"), base: join(home, ".ssh") }, { path: system, base: dirname(system) }];
  if (roots.some((item) => !isAbsolute(item.path))) throw new Error("配置文件路径必须是绝对路径或 ~/ 路径");
  const files = new Map(), cache = new Map(), aliases = new Map();
  let bytes = 0;
  async function load(path, base, stack = []) {
    path = resolve(path);
    if (stack.length >= 12) return [{ error: "Include 嵌套层数过多" }];
    let canonical, source;
    try {
      canonical = await realpath(path);
      if (stack.includes(canonical)) return [{ error: "Include 存在循环引用" }];
      if (cache.has(canonical)) return cache.get(canonical);
      if (files.size >= 64) return [{ error: "配置文件数量超过 64 个，请缩小范围" }];
      const info = await stat(canonical);
      if (!info.isFile() || info.size > 262144 || bytes + info.size > 2097152) throw new Error("配置文件过大或不是普通文件");
      source = await readFile(canonical, "utf8"); bytes += Buffer.byteLength(source);
      files.set(path, { path, exists: true, digest: createHash("sha256").update(source).digest("hex") });
    } catch (error) {
      const missing = error.code === "ENOENT" || error.code === "ENOTDIR";
      files.set(path, { path, exists: false, ...(missing ? {} : { error: "无法读取文件，请检查权限和文件大小" }) });
      return missing ? [] : [{ error: `无法读取配置文件 ${path}` }];
    }
    const nodes = [];
    for (const [index, line] of source.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const node = { source: path, line: index + 1 };
      try {
        const match = /^\s*([^\s=]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
        if (!match) throw new Error("缺少配置值");
        node.key = match[1].toLowerCase(); node.args = tokens(match[2]);
        if (!node.args.length) throw new Error("缺少配置值");
        if (node.key === "host") for (const alias of node.args) {
          if (!/[*!?]/.test(alias) && !aliases.has(alias) && aliases.size < 500) aliases.set(alias, { source: path, line: node.line });
        }
        if (node.key === "include") {
          node.children = [];
          for (const value of node.args) {
            const expanded = expand(value, context);
            const paths = await includeFiles(isAbsolute(expanded) ? expanded : join(base, expanded));
            for (const child of paths) node.children.push(...await load(child, base, [...stack, canonical]));
          }
        }
      } catch (error) { node.error = `${path}:${node.line}：${error.message}`; }
      nodes.push(node);
    }
    cache.set(canonical, nodes);
    return nodes;
  }
  const documents = [];
  for (const root of roots) documents.push(await load(root.path, root.base));
  const candidates = [];
  for (const [alias, location] of aliases) {
    const values = new Map(), warnings = new Set(), errors = new Set(), ignored = new Set();
    let declared = false;
    function evaluate(nodes, active = true) {
      for (const node of nodes) {
        if (node.error) { if (active || ["host", "match"].includes(node.key)) errors.add(node.error); continue; }
        if (node.key === "host") {
          active = matches(alias, node.args);
          if (active && node.args.includes(alias)) declared = true;
        } else if (node.key === "match") {
          active = matchCondition(node.args, alias, values, context);
          if (active === null) errors.add("包含无法静态判断的 Match 条件，请手动配置；不会执行 Match exec");
        } else if (active) {
          if (node.key === "include") { active = evaluate(node.children, active); continue; }
          if (["hostname", "user", "port", "identityfile", "identityagent"].includes(node.key) && node.args.length !== 1) {
            errors.add(`${node.source}:${node.line}：${node.key} 需要一个参数`); continue;
          }
          if (repeated.has(node.key)) values.set(node.key, [...(values.get(node.key) ?? []), node.args]);
          else if (!values.has(node.key)) values.set(node.key, node.args);
          if (!mapped.has(node.key) && !blocked.has(node.key)) ignored.add(node.key);
        }
      }
      return active;
    }
    for (const document of documents) evaluate(document);
    if (!declared) continue;
    for (const key of blocked) if (values.has(key) && values.get(key).join(" ").toLowerCase() !== "none") errors.add(`暂不支持 ${key}，请手动配置此连接`);
    if (values.has("canonicalizehostname") && !["no", "false"].includes(values.get("canonicalizehostname")[0].toLowerCase())) errors.add("暂不支持 CanonicalizeHostname，请手动配置此连接");
    if (values.get("identitiesonly")?.[0]?.toLowerCase() === "yes" || values.get("identityagent")?.[0]?.toLowerCase() === "none") errors.add("暂不支持 IdentitiesOnly yes / IdentityAgent none 的认证限制，请手动配置");
    if (ignored.size) warnings.add(`未导入选项：${[...ignored].join("、")}；使用插件的连接和主机校验规则`);
    const id = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(alias) ? alias : `ssh-${alias.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40)}-${createHash("sha256").update(alias).digest("hex").slice(0, 10)}`;
    let profile;
    try {
      const host = (values.get("hostname")?.[0] ?? alias).replace(/%%|%h/g, (value) => value === "%%" ? "%" : alias);
      if (/%[a-zA-Z]/.test(host)) throw new Error("HostName 包含不支持的替换符");
      const portText = values.get("port")?.[0] ?? "22";
      if (!/^\d+$/.test(portText)) throw new Error("Port 必须是数字");
      const profileContext = { ...context, h: host, n: alias, k: alias, p: portText, r: values.get("user")?.[0] ?? username };
      profile = { id, name: alias, host, username: profileContext.r, port: Number(portText), forwards: [] };
      const identities = values.get("identityfile") ?? [];
      const identity = identities.find((args) => args[0].toLowerCase() !== "none");
      if (identity) {
        profile.identityFile = expand(identity[0], profileContext);
        if (identities.length > 1) warnings.add("存在多个 IdentityFile，仅导入第一条私钥路径，可在导入后编辑");
      } else if (!identities.length) {
        for (const name of ["id_rsa", "id_ecdsa", "id_ed25519"]) {
          const key = join(home, ".ssh", name);
          try { if ((await stat(key)).isFile()) { profile.identityFile = key; warnings.add("未配置 IdentityFile，使用已存在的默认私钥路径"); break; } } catch { /* No default key at this path. */ }
        }
      }
      let agent = values.get("identityagent")?.[0];
      if (agent === "SSH_AUTH_SOCK") agent = env.SSH_AUTH_SOCK;
      else if (agent?.startsWith("$") && !agent.startsWith("${")) agent = env[agent.slice(1)];
      if (agent && agent.toLowerCase() !== "none") profile.agent = expand(agent, profileContext);
      const knownHosts = values.get("userknownhostsfile");
      if (knownHosts) {
        if (knownHosts[0].toLowerCase() !== "none") profile.knownHostsFile = expand(knownHosts[0], profileContext);
        else warnings.add("插件仍会校验主机公钥；连接前需配置 known_hosts 或公钥指纹");
        if (knownHosts.length > 1) warnings.add("存在多个 UserKnownHostsFile，仅导入第一个路径");
      }
      if (values.get("clearallforwardings")?.[0]?.toLowerCase() !== "yes") {
        for (const [key, direction] of [["localforward", "c2s"], ["remoteforward", "s2c"]]) {
          for (const [index, rule] of (values.get(key) ?? []).entries()) {
            try {
              if (rule.length !== 2) throw new Error("转发需要监听端口和目标地址两个参数");
              const binding = networkAddress(rule[0], true, direction === "c2s" && values.get("gatewayports")?.[0]?.toLowerCase() === "yes");
              const target = networkAddress(rule[1]);
              const forward = validateForward({ id: `${direction}-${index + 1}`, direction, bindHost: binding.host, bindPort: binding.port, targetHost: target.host, targetPort: target.port });
              if (!profile.forwards.some((item) => item.direction === direction && item.bindHost === forward.bindHost && item.bindPort === forward.bindPort && item.targetHost === forward.targetHost && item.targetPort === forward.targetPort)) profile.forwards.push(forward);
            } catch (error) { warnings.add(`${key} 第 ${index + 1} 条未导入：${error.message}`); }
          }
        }
      }
      profile = validateProfile(profile);
    } catch (error) { errors.add(error.message); profile = undefined; }
    candidates.push({ alias, ...location, ...(profile && { profile }), selectable: errors.size === 0 && Boolean(profile), warnings: [...warnings], errors: [...errors] });
  }
  const revision = createHash("sha256").update(JSON.stringify({ files: [...files.values()], candidates })).digest("hex");
  return { files: [...files.values()].map(({ digest, ...file }) => file), revision, candidates };
}
