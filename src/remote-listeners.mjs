import { OperationError } from "./errors.mjs";
import { isIP } from "node:net";

export function loopbackHost(host) {
  if (typeof host !== "string") return false;
  const value = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(value) === 4) return value.startsWith("127.");
  if (isIP(value) !== 6 || value.includes("%")) return false;
  const normalized = new URL("http://[" + value + "]/").hostname;
  return normalized === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(normalized);
}

export function privateForward(spec) {
  if (spec.direction !== "s2c") return spec;
  const host = spec.bindHost === "localhost" ? "127.0.0.1" : spec.bindHost === "[::1]" ? "::1" : spec.bindHost;
  if (!loopbackHost(host)) throw new OperationError("FORWARD_LOOPBACK_REQUIRED", "远程转发只能监听服务器的回环地址 127.0.0.1 或 ::1，仅供服务器本机访问");
  return { ...spec, bindHost: host };
}

// Inspect all listeners on a port, including IPv6. The requested SSH bind address
// alone is not proof: sshd's GatewayPorts=yes can override it to a wildcard.
export const listenerScopeFunction = `listener_scope() {
  port=$1
  byteorder=$(printf '\\001\\000' | od -An -tu2 2>/dev/null | tr -d '[:space:]') || byteorder=''
  if { [ "$byteorder" = 1 ] || [ "$byteorder" = 256 ]; } && [ -r /proc/net/tcp ] && { [ ! -e /proc/net/tcp6 ] || [ -r /proc/net/tcp6 ]; }; then
    hex=$(printf '%04X' "$port")
    files=/proc/net/tcp
    if [ -r /proc/net/tcp6 ]; then files="$files /proc/net/tcp6"; fi
    awk -v port="$hex" -v little="$byteorder" '
      $4 == "0A" {
        split($2, local, ":")
        if (toupper(local[2]) != port) next
        found = 1
        addr = toupper(local[1])
        if (little == 1) {
          if (length(addr) == 8 && substr(addr, 7, 2) == "7F") next
          if (addr == "00000000000000000000000001000000") next
          if (substr(addr, 1, 24) == "0000000000000000FFFF0000" && substr(addr, 31, 2) == "7F") next
        } else {
          if (length(addr) == 8 && substr(addr, 1, 2) == "7F") next
          if (addr == "00000000000000000000000000000001") next
          if (substr(addr, 1, 24) == "00000000000000000000FFFF" && substr(addr, 25, 2) == "7F") next
        }
        exposed = 1
      }
      END { if (exposed) print "exposed"; else if (found) print "loopback"; else print "unknown" }
    ' $files
  elif command -v ss >/dev/null 2>&1; then
    LC_ALL=C ss -H -ltn 2>/dev/null | awk -v port="$port" '
      { addr = $4; sub(/^.*:/, "", addr); if (addr != port) next; found = 1
        host = $4; sub(/:[^:]*$/, "", host)
        sub(/^\\[/, "", host); sub(/\\]$/, "", host)
        if (host != "::1" && host !~ /^(::ffff:)?127[.][0-9]+[.][0-9]+[.][0-9]+$/) exposed = 1 }
      END { if (exposed) print "exposed"; else if (found) print "loopback"; else print "unknown" }
    '
  else printf 'unknown\\n'; fi
}
`;

export function listenerCommand(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("监听端口无效");
  const script = "set -eu\n" + listenerScopeFunction + `printf 'MAGPIE_LISTENER_V1\\t${port}\\t%s\\n' "$(listener_scope ${port})"\n`;
  return "sh -c '" + script.replaceAll("'", "'\\''") + "'";
}

export async function verifyRemoteListener(client, port, execute, options = {}) {
  let result;
  try { result = await execute(client, listenerCommand(port), { ...options, timeoutMs: 10000, maxBytes: 4096 }); }
  catch { throw new OperationError("FORWARD_BIND_UNVERIFIED", "无法核实远端端口仅在服务器本机监听，已拒绝此转发；需要可执行 shell 及 /proc/net/tcp 或 ss"); }
  if (result.code !== 0 || result.stdout.trim() !== `MAGPIE_LISTENER_V1\t${port}\tloopback`) throw new OperationError("FORWARD_BIND_UNVERIFIED", "远端端口并非仅监听回环地址或监听范围无法核实，已关闭此 SSH 连接；请检查 GatewayPorts，使用 no 或 clientspecified");
}
