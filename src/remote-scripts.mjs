export const remoteActions = ["install", "update", "start", "stop", "restart", "enable_web", "uninstall"];

export function shellQuote(value) {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) throw new Error("远端参数无效");
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export const probeScript = `set -eu
command -v base64 >/dev/null || exit 70
emit() { printf '%s\\t' "$1"; printf '%s' "$2" | base64 | tr -d '\\r\\n'; printf '\\n'; }
printf 'MIGPIE_REMOTE_V1\\n'
emit platform "$(uname -s)"
emit architecture "$(uname -m)"
emit username "$(id -un)"
emit home "$HOME"
emit container "$(if [ -e /.dockerenv ] || [ -e /run/.containerenv ]; then printf true; else printf false; fi)"
config="\${XDG_CONFIG_HOME:-$HOME/.config}/magpie"
unit="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/magpie.service"
emit configDirectory "$config"
bin=$(command -v magpie 2>/dev/null || true)
if [ -z "$bin" ] && [ -x "$HOME/.local/bin/magpie" ]; then bin="$HOME/.local/bin/magpie"; fi
case "$bin" in /*) ;; *) bin='' ;; esac
emit binary "$bin"
emit managedBinary "$HOME/.local/bin/magpie"
emit unit "$unit"
if [ -n "$bin" ] && [ -x "$bin" ]; then
  emit installed true
  emit version "$("$bin" --version 2>/dev/null | head -c 120)"
  emit binaryHash "$(sha256sum "$bin" 2>/dev/null | cut -d ' ' -f 1 || true)"
else emit installed false; fi
systemd=false
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then systemd=true; fi
emit systemd "$systemd"
if [ -f "$unit" ]; then
  emit serviceInstalled true
  emit unitHash "$(sha256sum "$unit" 2>/dev/null | cut -d ' ' -f 1 || true)"
  emit webEnabled "$(if grep -q -- '--web=' "$unit"; then printf true; else printf false; fi)"
  emit webPort "$(sed -n 's/.*--web=[^ :"]*:\\([0-9]*\\).*/\\1/p' "$unit" | head -n 1)"
  emit webTLS "$(if grep -q 'MAGPIE_TLS_CERT=' "$unit"; then printf true; else printf false; fi)"
else emit serviceInstalled false; emit webEnabled false; fi
if [ "$systemd" = true ]; then
  emit serviceActive "$(systemctl --user show magpie.service --property=ActiveState --value 2>/dev/null || true)"
fi
emit linger "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)"
emit tools "$(for tool in curl sha256sum base64 mktemp install readlink; do command -v "$tool" >/dev/null && printf '%s ' "$tool"; done)"
emit locked "$(if [ -d "\${XDG_CONFIG_HOME:-$HOME/.config}/magpie-remote/operation.lock" ]; then printf true; else printf false; fi)"
`;

const common = `set -eu
umask 077
[ "$(uname -s)" = Linux ] || exit 71
[ -n "$HOME" ] && [ "$HOME" != / ] || exit 71
base="\${XDG_CONFIG_HOME:-$HOME/.config}/magpie-remote"
mkdir -p "$base"
lock="$base/operation.lock"
mkdir "$lock" 2>/dev/null || { printf 'MIGPIE_LOCKED\\n'; exit 75; }
trap 'rmdir "$lock" 2>/dev/null || true' EXIT
`;

export function actionScript(action, instance, operationId, release) {
  const bin = shellQuote(instance.binary || instance.managedBinary);
  const prefix = common + `bin=${bin}\n${instance.binaryHash ? `actual=$(sha256sum "$bin" | cut -d ' ' -f 1)\n[ "$actual" = ${shellQuote(instance.binaryHash)} ] || exit 79\n` : ""}${instance.unitHash ? `actual=$(sha256sum ${shellQuote(instance.unit)} | cut -d ' ' -f 1)\n[ "$actual" = ${shellQuote(instance.unitHash)} ] || exit 79\n` : ""}job="$base/operations/${operationId}"\nmkdir -p "$job"\nprintf running > "$job/state"\ntrap 'code=$?; if [ "$code" -eq 0 ]; then printf succeeded > "$job/state"; else printf failed > "$job/state"; fi; rmdir "$lock" 2>/dev/null || true' EXIT\n`;
  if (action === "install") {
    return prefix + `command -v magpie >/dev/null 2>&1 && exit 76
[ ! -e "$bin" ] && [ ! -L "$bin" ] || exit 76
command -v curl >/dev/null
command -v sha256sum >/dev/null
stage=$(mktemp -d "$base/download.XXXXXXXX")
trap 'code=$?; rm -f "$stage/magpie"; rmdir "$stage"; if [ "$code" -eq 0 ]; then printf succeeded > "$job/state"; else printf failed > "$job/state"; fi; rmdir "$lock" 2>/dev/null || true' EXIT
curl -fLsS --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 300 ${shellQuote(release.url)} -o "$stage/magpie"
printf '%s  %s\\n' ${shellQuote(release.sha256)} "$stage/magpie" | sha256sum -c - >/dev/null
chmod 755 "$stage/magpie"
"$stage/magpie" --version >/dev/null
mkdir -p "$HOME/.local/bin"
[ ! -e "$bin" ] && [ ! -L "$bin" ] || exit 76
install -m 755 "$stage/magpie" "$HOME/.local/bin/.magpie-${operationId}"
mv -n "$HOME/.local/bin/.magpie-${operationId}" "$bin"
[ ! -e "$HOME/.local/bin/.magpie-${operationId}" ] || exit 76
"$bin" --version >/dev/null
printf 'MIGPIE_DONE\\n'
`;
  }
  if (action === "update") {
    // The passphrase is the first line of stdin, before this script is parsed.
    return prefix + `command -v sha256sum >/dev/null
backup="$base/backups/${operationId}"
mkdir -p "$backup"
IFS= read -r passphrase
printf '%s\\n' "$passphrase" | "$bin" backup "$backup/config.magpie" >/dev/null 2>&1
unset passphrase
[ -s "$backup/config.magpie" ] || exit 77
cp -p "$bin" "$backup/magpie"
"$bin" update >/dev/null 2>&1
${instance.service.state === "running" ? '"$bin" daemon restart >/dev/null 2>&1\n' : ""}"$bin" --version >/dev/null
${instance.service.state === "running" ? '"$bin" healthcheck >/dev/null 2>&1\n' : ""}printf 'MIGPIE_DONE\\n'
`;
  }
  if (action === "enable_web") return prefix + `MAGPIE_ADDR=127.0.0.1:3425 "$bin" daemon install --web --addr 127.0.0.1:3430 >/dev/null 2>&1
"$bin" healthcheck >/dev/null 2>&1
printf 'MIGPIE_DONE\\n'
`;
  if (["start", "stop", "restart"].includes(action)) return prefix + `"$bin" daemon ${action} >/dev/null 2>&1
${action === "stop" ? "" : '"$bin" healthcheck >/dev/null 2>&1\n'}printf 'MIGPIE_DONE\\n'
`;
  if (action === "uninstall") return prefix + `expected="$HOME/.local/bin/magpie"
[ "$bin" = "$expected" ] && [ -f "$bin" ] && [ ! -L "$bin" ] || exit 78
[ "$(readlink -f "$bin")" = "$expected" ] || exit 78
${instance.service.installed ? '"$bin" daemon uninstall >/dev/null 2>&1\n' : ""}rm "$bin"
printf 'MIGPIE_DONE\\n'
`;
  throw new Error("未知的远端管理操作");
}

// Read only on an explicit user request; its output contains the management key.
export function webLinkCommand(instance) {
  return `${shellQuote(instance.binary)} daemon web`;
}
