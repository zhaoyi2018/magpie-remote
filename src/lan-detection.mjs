import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { shellQuote } from "./remote-scripts.mjs";
import { remoteHTTP } from "./remote-http.mjs";

function ipNumber(value) {
  if (isIP(value) === 4) return { bits: 32, value: value.split(".").reduce((number, part) => (number << 8n) | BigInt(part), 0n) };
  if (isIP(value) !== 6 || value.includes("%")) return;
  let normalized = new URL("http://[" + value + "]").hostname.slice(1, -1);
  if (normalized.startsWith("::ffff:")) {
    const parts = normalized.slice(7).split(":");
    if (parts.length === 2) return { bits: 32, value: (BigInt("0x" + parts[0]) << 16n) | BigInt("0x" + parts[1]) };
  }
  const [left, right] = normalized.split("::"), start = left ? left.split(":") : [], end = right ? right.split(":") : [];
  const parts = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill("0"), ...end];
  return { bits: 128, value: parts.reduce((number, part) => (number << 16n) | BigInt("0x" + part), 0n) };
}

function sameAddress(left, right) {
  const a = ipNumber(left), b = ipNumber(right);
  return a && b && a.bits === b.bits && a.value === b.value;
}

export function sameSubnet(address, entry) {
  const left = ipNumber(address), right = ipNumber(entry.address);
  if (!left || !right || left.bits !== right.bits || entry.internal) return false;
  const prefix = entry.cidr?.split("/")[1];
  if (prefix !== undefined && /^\d+$/.test(prefix) && Number(prefix) > 0 && Number(prefix) <= left.bits) {
    const shift = BigInt(left.bits - Number(prefix));
    return left.value >> shift === right.value >> shift;
  }
  const mask = ipNumber(entry.netmask);
  if (!mask || mask.bits !== left.bits || !mask.value) return false;
  const inverted = ((1n << BigInt(mask.bits)) - 1n) ^ mask.value;
  if ((inverted & (inverted + 1n)) !== 0n) return false;
  return (left.value & mask.value) === (right.value & mask.value);
}

export function networkProbeScript(hosts) {
  if (!hosts.length || hosts.length > 16 || hosts.some((host) => !isIP(host) || host.includes("%"))) throw new Error("局域网检测地址无效");
  return `# MIGPIE_LAN_NETWORK_V1
set -eu
command -v base64 >/dev/null || exit 69
printf 'MIGPIE_LAN_NETWORK_V1\\n'
printf 'ssh\\t'; printf '%s' "\${SSH_CONNECTION:-}" | base64 | tr -d '\\r\\n'; printf '\\n'
printf 'curl\\t'; if command -v curl >/dev/null; then printf 'true\\n'; else printf 'false\\n'; fi
${hosts.map((host) => `route=''
if command -v ip >/dev/null; then route=$(ip ${isIP(host) === 6 ? "-6" : "-4"} route get ${shellQuote(host)} 2>/dev/null | head -c 1024) || route=''; fi
printf 'route\\t%s\\t' ${shellQuote(host)}; printf '%s' "$route" | base64 | tr -d '\\r\\n'; printf '\\n'`).join("\n")}
`;
}

export function parseNetwork(stdout, hosts) {
  const lines = stdout.replace(/\r?\n$/, "").split(/\r?\n/), routes = new Map();
  if (lines.shift() !== "MIGPIE_LAN_NETWORK_V1") throw new Error("局域网检测响应无效");
  let ssh, curl;
  const decode = (value) => {
    if (typeof value !== "string" || value.length > 2048 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("局域网检测字段无效");
    return Buffer.from(value, "base64").toString("utf8");
  };
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields[0] === "ssh" && fields.length === 2 && ssh === undefined) ssh = decode(fields[1]);
    else if (fields[0] === "curl" && fields.length === 2 && curl === undefined && ["true", "false"].includes(fields[1])) curl = fields[1] === "true";
    else if (fields[0] === "route" && fields.length === 3 && hosts.includes(fields[1]) && !routes.has(fields[1])) routes.set(fields[1], decode(fields[2]));
    else throw new Error("局域网检测字段无效");
  }
  if (ssh === undefined || curl === undefined || routes.size !== hosts.length) throw new Error("局域网检测信息不完整");
  return { ssh: ssh.trim().split(/\s+/), curl, routes };
}

export async function detectDirectGateway(sessions, id, gateways, { signal, interfaces = networkInterfaces() } = {}) {
  const candidates = gateways.slice(0, 16), hosts = [...new Set(candidates.map((gateway) => gateway.host))];
  let network;
  try {
    const response = await sessions.execute(id, "sh -s", { input: networkProbeScript(hosts), signal, timeoutMs: 5000, maxBytes: 32768 });
    if (response.code !== 0) throw new Error("probe failed");
    network = parseNetwork(response.stdout, hosts);
  } catch { return { reason: "无法确认远端网络环境", remoteHTTP: false }; }
  if (!network.curl) return { reason: "远端缺少直连检测所需的 curl", remoteHTTP: false };
  const entries = Object.values(interfaces).flatMap((values) => values ?? []);
  const eligible = candidates.flatMap((gateway) => {
    const entry = entries.find((item) => sameAddress(item.address, gateway.host) && !item.internal);
    if (!entry) return [];
    const route = network.routes.get(gateway.host).trim(), words = route.split(/\s+/);
    const source = words[words.indexOf("src") + 1];
    const routed = words.includes("via") || /\b(?:unreachable|blackhole|prohibit|throw)\b/.test(route);
    const [client, , server] = network.ssh;
    const onLink = route ? !routed && words.includes("dev") && words.includes("src") && sameSubnet(source, entry)
      : network.ssh.length === 4 && entries.some((item) => !item.internal && sameAddress(item.address, client)) && sameSubnet(server, entry);
    return [{ gateway, onLink }];
  }).sort((left, right) => Number(right.onLink) - Number(left.onLink));
  // Route/subnet evidence only prioritizes probes. Routed LANs, missing route
  // details and a different SSH ingress address still need an actual HTTP test.
  let directFailure;
  for (const { gateway } of eligible) {
    if (signal?.aborted) break;
    try {
      const response = await remoteHTTP(sessions, id, gateway.url + "/", { signal, context: "验证本机局域网网关", headers: { Authorization: "Bearer " + gateway.key, "x-api-key": gateway.key }, maxBytes: 16384 });
      if (signal?.aborted) break;
      const info = JSON.parse(response.body);
      if (response.status === 200 && info?.name === "magpie" && info.version === gateway.info.version) return { gateway, remoteHTTP: true, reason: "远端已通过局域网地址和共享密钥验证网关" };
    } catch (error) { if (error.code === "PROVIDER_LINK_HTTP") directFailure = error.message; }
  }
  return { remoteHTTP: true, reason: signal?.aborted ? "直连检测已取消" : eligible.length ? "远端局域网网关不可达或鉴权未通过" + (directFailure ? "：" + directFailure : "") : "本机局域网网关地址已变化或不属于当前网卡" };
}
