import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandPath } from "./config.mjs";

export function fingerprint(key) {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function equal(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function matches(pattern, host) {
  if (pattern.startsWith("|1|")) {
    const [, , salt, digest] = pattern.split("|");
    if (!salt || !digest) return false;
    return equal(createHmac("sha1", Buffer.from(salt, "base64")).update(host).digest("base64"), digest);
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(host);
}

function hostMatches(patterns, host) {
  const entries = patterns.split(",");
  if (entries.some((entry) => entry.startsWith("!") && matches(entry.slice(1), host))) return false;
  return entries.some((entry) => !entry.startsWith("!") && matches(entry, host));
}

export async function hostVerifier(profile) {
  let contents = "";
  const file = profile.knownHostsFile ? expandPath(profile.knownHostsFile) : join(homedir(), ".ssh", "known_hosts");
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("无法读取 known_hosts 文件", { cause: error });
  }
  const host = profile.port === 22 ? profile.host : `[${profile.host}]:${profile.port}`;
  const entries = contents.split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (!fields[0] || fields[0].startsWith("#")) return [];
    const marker = fields[0].startsWith("@") ? fields.shift() : "";
    if (fields.length < 3 || !hostMatches(fields[0], host)) return [];
    return [{ marker, key: Buffer.from(fields[2], "base64") }];
  });
  return (key) => {
    if (entries.some((entry) => entry.marker === "@revoked" && equal(entry.key, key))) return false;
    if (profile.hostFingerprint) return equal(fingerprint(key), profile.hostFingerprint);
    return entries.some((entry) => !entry.marker && equal(entry.key, key));
  };
}
