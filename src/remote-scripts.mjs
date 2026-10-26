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
  help=$("$bin" --help 2>/dev/null) || help=''
  commands=$(printf '%s\\n' "$help" | sed -n 's/^[[:space:]]*magpie[[:space:]][[:space:]]*//p')
  daemon=$(printf '%s\\n' "$commands" | sed -n 's/^daemon[[:space:]][[:space:]]*//p')
  has_command() { printf '%s\\n' "$commands" | grep -Eq "^$1([[:space:]]|$)"; }
  has_daemon() { printf '%s\\n' "$daemon" | tr '[]|' '   ' | grep -Eq "(^|[[:space:]])$1([[:space:]]|$)"; }
  capabilities=''
  for command in update backup healthcheck; do
    if has_command "$command"; then capabilities="$capabilities $command"; fi
  done
  for action in install uninstall start stop restart web; do
    if has_daemon "$action"; then capabilities="$capabilities daemon_$action"; fi
  done
  install_help=$(printf '%s\\n' "$daemon" | grep -E '^install([[:space:]]|$)' | tr '[]=' '   ' || true)
  if printf '%s\\n' "$install_help" | grep -Eq -- '(^|[[:space:]])--web([[:space:]]|$)' && printf '%s\\n' "$install_help" | grep -Eq -- '(^|[[:space:]])--addr([[:space:]]|$)'; then capabilities="$capabilities daemon_install_web"; fi
  emit capabilities "$capabilities"
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
emit tools "$(for tool in curl sha256sum base64 mktemp install readlink tar; do command -v "$tool" >/dev/null && printf '%s ' "$tool"; done)"
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
  const prefix = common + `bin=${bin}
job="$base/operations/${operationId}"
step=preparing
reason=command_failed
backup_ready=false
stage=''
finish() {
  code=$?
  trap - EXIT
  set +e
  if [ -n "$stage" ]; then rm -f "$stage/magpie"; rmdir "$stage"; fi
  if [ -f "$job/step" ]; then step=$(cat "$job/step"); fi
  if [ -f "$job/reason" ]; then reason=$(cat "$job/reason"); fi
  state=failed
  if [ "$code" -eq 0 ]; then state=succeeded; step=completed; reason=none; fi
  result=$(printf 'MIGPIE_RESULT_V1\\t%s\\t%s\\t%s\\t%s\\t%s' '${operationId}' "$step" "$code" "$reason" "$backup_ready")
  if [ -d "$job" ]; then
    printf '%s\\n' "$result" > "$job/result.tmp" && mv "$job/result.tmp" "$job/result"
    printf '%s' "$state" > "$job/state"
  fi
  rmdir "$lock" 2>/dev/null || true
  printf '%s\\n' "$result"
  exit "$code"
}
trap finish EXIT
mkdir -p "$job"
printf running > "$job/state"
set_step() { step=$1; printf '%s' "$step" > "$job/step"; }
# The backup runs in a pipeline subshell; files retain its stage and reason.
run_step() {
  set_step "$1"
  shift
  if output=$("$@" 2>&1); then return 0; else code=$?; fi
  reason=command_failed
  if printf '%s' "$output" | grep -Eiq 'permission denied|operation not permitted|read-only file system|access is denied'; then reason=permission;
  elif printf '%s' "$output" | grep -Eiq 'no space left|disk (is )?full|disk quota exceeded'; then reason=disk_full;
  elif printf '%s' "$output" | grep -Eiq 'could not resolve|no such host|name resolution|connection (refused|reset|timed out)|network is unreachable|network.*unavailable|TLS handshake|certificate|x509|i/o timeout|deadline exceeded|failed to (fetch|download)|proxyconnect|HTTP[^[:cntrl:]]*(403|407|429|500|502|503|504)|status[^[:cntrl:]]*(403|407|429|500|502|503|504)'; then reason=network;
  elif printf '%s' "$output" | grep -Eiq 'passphrase|password|not a terminal|inappropriate ioctl|/dev/tty'; then reason=interactive;
  elif printf '%s' "$output" | grep -Eiq 'unknown (command|flag)|unrecognized (command|option)|unsupported (command|option)'; then reason=unsupported;
  fi
  unset output
  printf '%s' "$reason" > "$job/reason"
  return "$code"
}
set_step verifying
${instance.binaryHash ? `actual=$(sha256sum "$bin" | cut -d ' ' -f 1)\n[ "$actual" = ${shellQuote(instance.binaryHash)} ] || exit 79\n` : ""}${instance.unitHash ? `actual=$(sha256sum ${shellQuote(instance.unit)} | cut -d ' ' -f 1)\n[ "$actual" = ${shellQuote(instance.unitHash)} ] || exit 79\n` : ""}`;
  if (action === "install") {
    return prefix + `command -v magpie >/dev/null 2>&1 && exit 76
[ ! -e "$bin" ] && [ ! -L "$bin" ] || exit 76
command -v curl >/dev/null
command -v sha256sum >/dev/null
stage=$(mktemp -d "$base/download.XXXXXXXX")
run_step downloading curl -fLsS --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 300 ${shellQuote(release.url)} -o "$stage/magpie"
set_step verifying
printf '%s  %s\\n' ${shellQuote(release.sha256)} "$stage/magpie" | sha256sum -c - >/dev/null
chmod 755 "$stage/magpie"
run_step checking_version "$stage/magpie" --version
set_step installing
mkdir -p "$HOME/.local/bin"
[ ! -e "$bin" ] && [ ! -L "$bin" ] || exit 76
install -m 755 "$stage/magpie" "$HOME/.local/bin/.magpie-${operationId}"
mv -n "$HOME/.local/bin/.magpie-${operationId}" "$bin"
[ ! -e "$HOME/.local/bin/.magpie-${operationId}" ] || exit 76
run_step checking_version "$bin" --version
printf 'MIGPIE_DONE\\n'
`;
  }
  if (action === "update") {
    const backup = instance.capabilities?.includes("backup") ? `IFS= read -r passphrase
printf '%s\\n' "$passphrase" | run_step backing_up "$bin" backup "$backup/config.magpie"
unset passphrase
[ -s "$backup/config.magpie" ] || exit 77
` : `command -v tar >/dev/null
config=${shellQuote(instance.configDirectory)}
if [ -d "$config" ]; then
  run_step backing_up tar -czf "$backup/config.tar.gz" -C "$config" .
  [ -s "$backup/config.tar.gz" ] || exit 77
elif [ -e "$config" ] || [ -L "$config" ]; then exit 77
else printf 'Configuration directory did not exist before update.\\n' > "$backup/config.absent"; fi
`;
    return prefix + `command -v sha256sum >/dev/null
set_step preparing_backup
mkdir -p "$base/backups"
backup="$base/backups/${operationId}"
mkdir -m 700 "$backup"
set_step backing_up
${backup}run_step saving_binary cp -p "$bin" "$backup/magpie"
backup_ready=true
run_step updating "$bin" update </dev/null
${instance.service.state === "running" ? 'run_step restarting "$bin" daemon restart </dev/null\n' : ""}run_step checking_version "$bin" --version </dev/null
${instance.service.state === "running" ? 'run_step healthcheck "$bin" healthcheck </dev/null\n' : ""}printf 'MIGPIE_DONE\\n'
`;
  }
  if (action === "enable_web") return prefix + `MAGPIE_ADDR=127.0.0.1:3425 run_step enabling_web "$bin" daemon install --web --addr 127.0.0.1:3430 </dev/null
run_step healthcheck "$bin" healthcheck </dev/null
printf 'MIGPIE_DONE\\n'
`;
  if (["start", "stop", "restart"].includes(action)) return prefix + `run_step ${action === "start" ? "starting" : action === "stop" ? "stopping" : "restarting"} "$bin" daemon ${action} </dev/null
${action === "stop" ? "" : 'run_step healthcheck "$bin" healthcheck </dev/null\n'}printf 'MIGPIE_DONE\\n'
`;
  if (action === "uninstall") return prefix + `expected="$HOME/.local/bin/magpie"
[ "$bin" = "$expected" ] && [ -f "$bin" ] && [ ! -L "$bin" ] || exit 78
[ "$(readlink -f "$bin")" = "$expected" ] || exit 78
${instance.service.installed ? 'run_step uninstalling "$bin" daemon uninstall </dev/null\n' : ""}run_step uninstalling rm "$bin"
printf 'MIGPIE_DONE\\n'
`;
  throw new Error("未知的远端管理操作");
}

// Read only on an explicit user request; its output contains the management key.
export function webLinkCommand(instance) {
  return `${shellQuote(instance.binary)} daemon web`;
}
