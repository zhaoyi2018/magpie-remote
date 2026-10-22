import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value;
}

export function text(value, label, fallback) {
  const result = value ?? fallback;
  if (typeof result !== "string" || !result.trim() || /[\x00-\x1f\x7f]/.test(result)) {
    throw new Error(`${label} 必须是非空文本，且不能包含控制字符`);
  }
  return result.trim();
}

export function integer(value, label, fallback, min = 1, max = 65535) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${label} 必须是 ${min}–${max} 之间的整数`);
  }
  return result;
}

export function identifier(value, label = "id") {
  const result = text(value, label);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(result)) {
    throw new Error(`${label} 只能包含字母、数字、下划线和连字符，长度为 1–64`);
  }
  return result;
}

function onlyKeys(value, keys, label) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label} 不支持字段 ${key}`);
  }
}

export function expandPath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  if (!isAbsolute(value)) throw new Error("文件路径必须是绝对路径或以 ~/ 开头");
  return value;
}

export function validateForward(value) {
  object(value, "转发配置");
  onlyKeys(value, ["id", "direction", "bindHost", "bindPort", "targetHost", "targetPort"], "转发配置");
  const direction = text(value.direction, "direction");
  if (!["c2s", "s2c"].includes(direction)) throw new Error("direction 必须是 c2s 或 s2c");
  return {
    id: identifier(value.id, "转发 id"),
    direction,
    bindHost: text(value.bindHost, "bindHost", "127.0.0.1"),
    bindPort: integer(value.bindPort, "bindPort", undefined, 0),
    targetHost: text(value.targetHost, "targetHost", "127.0.0.1"),
    targetPort: integer(value.targetPort, "targetPort"),
  };
}

export function validateProfile(value) {
  object(value, "连接配置");
  const optional = ["identityFile", "agent", "passwordEnv", "passphraseEnv", "knownHostsFile", "hostFingerprint"];
  onlyKeys(value, ["id", "name", "host", "port", "username", "forwards", ...optional], "连接配置");
  if (value.forwards !== undefined && !Array.isArray(value.forwards)) throw new Error("forwards 必须是数组");
  const profile = {
    id: identifier(value.id, "连接 id"),
    name: text(value.name, "name", value.id),
    host: text(value.host, "host"),
    port: integer(value.port, "port", 22),
    username: text(value.username, "username"),
    forwards: (value.forwards ?? []).map(validateForward),
  };
  for (const key of optional) {
    if (value[key] !== undefined) profile[key] = text(value[key], key);
  }
  for (const key of ["identityFile", "knownHostsFile"]) {
    if (profile[key]) expandPath(profile[key]);
  }
  for (const key of ["passwordEnv", "passphraseEnv"]) {
    if (profile[key] && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(profile[key])) {
      throw new Error(`${key} 必须是环境变量名称`);
    }
  }
  if (profile.hostFingerprint && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(profile.hostFingerprint)) {
    throw new Error("hostFingerprint 必须是无填充的 SHA256:… SSH 公钥指纹");
  }
  if (new Set(profile.forwards.map((item) => item.id)).size !== profile.forwards.length) {
    throw new Error("转发 id 不能重复");
  }
  return profile;
}

export function pluginOptions(input = {}, options = {}) {
  object(options, "插件选项");
  onlyKeys(options, ["dataDirectory", "connectTimeoutMs", "forwardTimeoutMs"], "插件选项");
  const directory = input.directory ?? join(homedir(), ".config", "magpie");
  return {
    dataDirectory: options.dataDirectory
      ? expandPath(text(options.dataDirectory, "dataDirectory"))
      : join(directory, "migpie-remote"),
    connectTimeoutMs: integer(options.connectTimeoutMs, "connectTimeoutMs", 15000, 100, 45000),
    forwardTimeoutMs: integer(options.forwardTimeoutMs, "forwardTimeoutMs", 10000, 100, 15000),
  };
}
