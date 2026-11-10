import { isIP } from "node:net";

const marker = "MAGPIE_FORWARD_CONFLICT_V1";
const endMarker = "MAGPIE_FORWARD_CONFLICT_END";

// Read only: no sudo, process arguments or changes to the listener. Only the
// requested port and its process IDs leave the remote inspection command.
export function forwardConflictScript(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("监听端口无效");
  return `set -eu
port=${port}
if command -v ss >/dev/null 2>&1 && sockets=$(LC_ALL=C ss -H -ltnpe "sport = :$port" 2>/dev/null); then
  rows=$(printf '%s\n' "$sockets" | awk -v port="$port" '$1 == "LISTEN" { addr = $4; sub(/^.*:/, "", addr); if (addr == port) print }')
  printf '${marker}\t%s\tss\n' "$port"
  if [ -n "$rows" ]; then
    printf '%s\n' "$rows" | sed 's/^/SS\t/'
    pids=$(printf '%s\n' "$rows" | awk '{ rest = $0; while (match(rest, /pid=[0-9]+/)) { print substr(rest, RSTART + 4, RLENGTH - 4); rest = substr(rest, RSTART + RLENGTH) } }' | sort -un)
    for pid in $pids; do
      if details=$(LC_ALL=C ps -p "$pid" -o pid= -o user= -o comm= 2>/dev/null); then
        printf '%s\n' "$details" | tr '\t\r' '  ' | sed 's/^/PS\t/'
      fi
    done
    uids=$(printf '%s\n' "$rows" | awk '{ rest = $0; while (match(rest, /uid:[0-9]+/)) { print substr(rest, RSTART + 4, RLENGTH - 4); rest = substr(rest, RSTART + RLENGTH) } }' | sort -un)
    for uid in $uids; do
      if owner=$(id -nu "$uid" 2>/dev/null); then
        owner=$(printf '%s' "$owner" | tr '\t\r\n' '   ')
        printf 'UID\t%s\t%s\n' "$uid" "$owner"
      fi
    done
  fi
elif command -v lsof >/dev/null 2>&1; then
  code=0
  rows=$(LC_ALL=C lsof -nP -a -iTCP:"$port" -sTCP:LISTEN -FpcuLfn 2>&1) || code=$?
  if [ "$code" = 0 ] || { [ "$code" = 1 ] && [ -z "$rows" ]; }; then
    printf '${marker}\t%s\tlsof\n' "$port"
    if [ -n "$rows" ]; then printf '%s\n' "$rows" | sed 's/^/LSOF\t/'; fi
  else printf '${marker}\t%s\tunavailable\n' "$port"; fi
else printf '${marker}\t%s\tunavailable\n' "$port"; fi
printf '${endMarker}\n'
`;
}

function text(value) {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().slice(0, 48);
}

function endpoint(value, port) {
  const split = value.lastIndexOf(":");
  if (split < 0 || value.slice(split + 1) !== String(port)) throw new Error("Invalid listener port");
  const host = value.slice(0, split).replace(/^\[|\]$/g, "");
  if (host !== "*" && !isIP(host)) throw new Error("Invalid listener address");
  return (isIP(host) === 6 ? `[${host}]` : host) + ":" + port;
}

export function parseForwardConflict(stdout, port) {
  const lines = stdout.trim().split(/\r?\n/);
  const header = lines.shift()?.split("\t");
  if (header?.length !== 3 || header[0] !== marker || header[1] !== String(port)
    || !["ss", "lsof", "unavailable"].includes(header[2]) || lines.pop() !== endMarker) throw new Error("Invalid port inspection");
  const source = header[2], listeners = [], processes = new Map(), owners = new Map();
  let current;
  for (const line of lines) {
    const split = line.indexOf("\t"), kind = line.slice(0, split), value = line.slice(split + 1);
    if (source === "ss" && kind === "SS") {
      const match = /^LISTEN\s+\d+\s+\d+\s+(\S+)\s+\S+(?:\s+(.*))?$/.exec(value);
      if (!match) throw new Error("Invalid socket row");
      const details = match[2] ?? "";
      const uid = /(?:^|\s)uid:(\d+)(?:\s|$)/.exec(details)?.[1];
      listeners.push({ address: endpoint(match[1], port), ...(uid && { uid }),
        processes: [...details.matchAll(/"([^"\r\n]*)",pid=([1-9]\d*)/g)].map((item) => ({ pid: item[2], name: text(item[1]) })) });
    } else if (source === "ss" && kind === "PS") {
      const match = /^\s*([1-9]\d*)\s+(\S+)\s+(.+?)\s*$/.exec(value);
      if (!match) throw new Error("Invalid process row");
      processes.set(match[1], { user: text(match[2]), name: text(match[3]) });
    } else if (source === "ss" && kind === "UID") {
      const match = /^(\d+)\t([^\t]+)$/.exec(value);
      if (!match) throw new Error("Invalid owner row");
      owners.set(match[1], text(match[2]));
    } else if (source === "lsof" && kind === "LSOF") {
      const field = value.slice(0, 1), data = value.slice(1);
      if (field === "p" && /^[1-9]\d*$/.test(data)) current = { pid: data };
      else if (!current) throw new Error("Missing process ID");
      else if (field === "c") current.name = text(data);
      else if (field === "u" && /^\d+$/.test(data)) current.uid = data;
      else if (field === "L") current.user = text(data);
      else if (field === "f" && /^\d+/.test(data)) { /* File descriptor boundary. */ }
      else if (field === "n") listeners.push({ address: endpoint(data, port), processes: [{ ...current }] });
      else throw new Error("Invalid lsof row");
    } else throw new Error("Unexpected port inspection row");
  }
  for (const listener of listeners) {
    if (listener.uid && owners.has(listener.uid)) listener.user = owners.get(listener.uid);
    listener.processes = listener.processes.map((process) => ({ ...(listener.uid && { uid: listener.uid }),
      ...(listener.user && { user: listener.user }), ...process, ...processes.get(process.pid) }));
  }
  return { available: source !== "unavailable", listeners };
}

export async function forwardRejectionMessage(client, forward, execute, { signal, timeoutMs = 3000 } = {}) {
  const address = (isIP(forward.bindHost) === 6 ? `[${forward.bindHost}]` : forward.bindHost) + ":" + forward.bindPort;
  const prefix = `服务器拒绝此转发（远端 ${address}）`;
  if (forward.bindPort === 0) return prefix + "：服务器未分配监听端口，请检查 SSH 转发权限和可用端口";
  let inspection;
  try {
    const result = await execute(client, "sh -s", { input: forwardConflictScript(forward.bindPort), signal, timeoutMs, maxBytes: 16384 });
    if (result.code !== 0) throw new Error("Port inspection failed");
    inspection = parseForwardConflict(result.stdout, forward.bindPort);
  } catch { /* Inspection failure must preserve the explicit forwarding rejection. */ }
  if (!inspection?.available) return prefix + "：无法查询占用者，远端需要可执行 shell、ss 或 lsof 及查询权限；请检查端口占用和 SSH 转发权限";
  if (!inspection.listeners.length) return prefix + "：当前账户可见范围内未发现此端口的监听；请检查 AllowTcpForwarding、PermitListen、DisableForwarding 等 SSH 限制及端口绑定权限";
  const described = inspection.listeners.slice(0, 3).map((listener) => {
    const processes = listener.processes.slice(0, 3).map((process) => (process.name || "未知进程") + `（PID ${process.pid}`
      + (process.user ? `，用户 ${process.user}` : process.uid ? `，UID ${process.uid}` : "，用户不可见") + "）");
    return listener.address + "：" + (processes.length ? processes.join("、")
      : "进程信息不可见" + (listener.user ? `，用户 ${listener.user}` : listener.uid ? `，UID ${listener.uid}` : ""));
  });
  const hidden = inspection.listeners.some((listener) => !listener.processes.length);
  return prefix + "：检测到监听 " + described.join("；") + (inspection.listeners.length > 3 ? "；另有其他监听" : "")
    + (hidden ? "；当前账户可能无权查看其他用户的 PID/进程名，可由管理员核实" : "");
}
