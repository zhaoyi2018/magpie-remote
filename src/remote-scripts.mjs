import { backupIdPattern, backupInspection } from "./remote-backups.mjs";
import { servicePolicyFunctions } from "./remote-service.mjs";

export const remoteActions = ["install", "update", "start", "stop", "restart", "enable_web", "backup", "restore", "delete_backup", "uninstall"];
export const backupActions = ["update", "backup", "restore"];

export function shellQuote(value) {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) throw new Error("远端参数无效");
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

// A generated script is passed as one command argument, leaving stdin for bytes.
export function scriptCommand(script) {
  if (typeof script !== "string" || script.includes("\0")) throw new Error("远端脚本无效");
  return "sh -c '" + script.replaceAll("'", "'\\''") + "'";
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
  for command in update backup restore healthcheck; do
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
${servicePolicyFunctions}
emit serviceRebuildSafe "$(if [ "$systemd" = true ] && service_overrides_clear; then printf true; else printf false; fi)"
emit serviceScope "$(if [ "$systemd" = true ] && service_private_config; then
  if [ "$(systemctl --user show magpie.service --property=ActiveState --value 2>/dev/null)" != active ] || service_private_listeners; then printf loopback; else printf unknown; fi
else printf unknown; fi)"
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
[ ! -e "$base/recovery.lock" ] || exit 75
mkdir "$lock" 2>/dev/null || { printf 'MIGPIE_LOCKED\\n'; exit 75; }
trap 'rmdir "$lock" 2>/dev/null || true' EXIT
[ ! -e "$base/recovery.lock" ] || exit 75
`;

// Recovery is explicit: the user must verify that the task and its children have
// ended. Legacy locks have no owner; never infer their safety from a probe alone.
export function recoveryScript(operationId) {
  if (!backupIdPattern.test(operationId ?? "")) throw new Error("操作标识无效");
  return `set -eu
umask 077
base="\${XDG_CONFIG_HOME:-$HOME/.config}/magpie-remote"
lock="$base/operation.lock"
[ ! -L "$base" ] && [ ! -L "$lock" ] || exit 78
mkdir -p "$base"
if [ -d "$base/recovery.lock" ] && [ ! -L "$base/recovery.lock" ]; then
  recovery_pid=$(cat "$base/recovery.lock/owner" 2>/dev/null || true)
  case "$recovery_pid" in ''|0|*[!0-9]*) exit 75 ;; esac
  if kill -0 "$recovery_pid" 2>/dev/null || [ -d "/proc/$recovery_pid" ]; then exit 75; fi
  [ "$(cat "$base/recovery.lock/owner")" = "$recovery_pid" ] || exit 75
  rm "$base/recovery.lock/owner"
  rmdir "$base/recovery.lock" || exit 78
fi
mkdir "$base/recovery.lock" 2>/dev/null || exit 75
trap 'rm -f "$base/recovery.lock/owner"; rmdir "$base/recovery.lock" 2>/dev/null || true' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 141' PIPE
printf '%s' "$$" > "$base/recovery.lock/owner"
if [ -e "$lock" ]; then
  [ -d "$lock" ] || exit 78
  if [ -e "$lock/owner" ] || [ -L "$lock/owner" ]; then
    [ -f "$lock/owner" ] && [ ! -L "$lock/owner" ] || exit 78
    owner=$(cat "$lock/owner")
    owner_id=\${owner%%:*}
    owner_pid=\${owner#*:}
    [ "$owner_id" = '${operationId}' ] || exit 75
    case "$owner_pid" in ''|0|*[!0-9]*) exit 78 ;; esac
    # A reused PID also blocks recovery, conservatively leaving the lock intact.
    if kill -0 "$owner_pid" 2>/dev/null || [ -d "/proc/$owner_pid" ]; then exit 75; fi
    [ "$(cat "$lock/owner")" = "$owner" ] || exit 75
    rm "$lock/owner"
  fi
  rmdir "$lock" || exit 78
fi
printf 'MIGPIE_RECOVERED_V1\\t%s\\n' '${operationId}'
`;
}

export function actionScript(action, instance, operationId, release, selectedBackup) {
  if (["restore", "delete_backup"].includes(action) && (!backupIdPattern.test(selectedBackup?.id ?? "") || !/^[a-f0-9]{64}$/.test(selectedBackup?.fingerprint ?? ""))) throw new Error("备份标识或校验值无效");
  const bin = shellQuote(instance.binary || instance.managedBinary);
  const restoreCleanup = action === "restore" ? `  if [ -n "$restore_stage" ]; then
    if [ "$restore_applied" = false ] && [ -d "$restore_stage/previous" ]; then
      restore_config_state=unknown
      restore_rollback_state=failed
      if [ ! -e "$target" ] && [ ! -L "$target" ] && mv -- "$restore_stage/previous" "$target" >/dev/null 2>&1; then
        restore_config_state=rolled_back
        restore_rollback_state=succeeded
      fi
    fi
    if [ "$restore_applied" = true ] || [ ! -e "$restore_stage/previous" ]; then rm -rf -- "$restore_stage" >/dev/null 2>&1; fi
  fi
` : "";
  const restoreResult = action === "restore" ? `  restore_recovery=''
  if [ "$restore_rollback_state" = failed ] && [ -d "$restore_stage/previous" ]; then restore_recovery="$restore_stage/previous";
  elif [ "$backup_ready" = true ]; then restore_recovery="$base/backups/${operationId}"; fi
  restore_recovery=$(printf '%s' "$restore_recovery" | base64 | tr -d '\\r\\n')
  restore_result=$(printf 'MIGPIE_RESTORE_V1\\t%s\\t%s\\t%s\\t%s\\t%s' '${operationId}' "$restore_config_state" "$restore_service_state" "$restore_rollback_state" "$restore_recovery")
  result=$(printf '%s\\n%s' "$result" "$restore_result")
` : "";
  const startsService = ["enable_web", "start", "restart"].includes(action) || ["update", "restore"].includes(action) && instance.service.state === "running";
  const prefix = common + `bin=${bin}
${startsService ? "unit=" + shellQuote(instance.unit) + "\n" : ""}job="$base/operations/${operationId}"
step=preparing
reason=command_failed
backup_ready=false
stage=''
replacement=''
restore_stage=''
restore_applied=false
service_pending=false
${action === "restore" ? "restore_config_state=not_applied\nrestore_service_state=unchanged\nrestore_rollback_state=not_needed\n" : ""}finish() {
  code=$?
  trap - EXIT
  trap '' HUP INT TERM PIPE
  set +e
  if [ "$service_pending" = true ]; then systemctl --user stop magpie.service >/dev/null 2>&1; fi
  rm -f "$job/output"
  if [ -n "$stage" ]; then rm -f "$stage/magpie"; rmdir "$stage"; fi
  if [ -n "$replacement" ]; then rm -f -- "$replacement"; fi
${restoreCleanup}  if [ -f "$job/step" ]; then step=$(cat "$job/step"); fi
  if [ -f "$job/reason" ]; then reason=$(cat "$job/reason"); fi
  state=failed
  if [ "$code" -eq 0 ]; then state=succeeded; step=completed; reason=none; fi
  result=$(printf 'MIGPIE_RESULT_V1\\t%s\\t%s\\t%s\\t%s\\t%s' '${operationId}' "$step" "$code" "$reason" "$backup_ready")
${restoreResult}  if [ -d "$job" ]; then
    printf '%s\\n' "$result" > "$job/result.tmp" && mv "$job/result.tmp" "$job/result"
    printf '%s' "$state" > "$job/state"
  fi
  if [ "$(cat "$lock/owner" 2>/dev/null)" = '${operationId}:'"$$" ]; then rm -f "$lock/owner"; rmdir "$lock" 2>/dev/null || true; fi
  printf '%s\\n' "$result"
  exit "$code"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 141' PIPE
printf '%s:%s' '${operationId}' "$$" > "$lock/owner"
[ ! -e "$base/recovery.lock" ] || exit 75
mkdir -p "$job"
printf running > "$job/state"
emit_progress() { printf 'MIGPIE_PROGRESS_V1\\t%s\\t%s\\t%s\\t%s\\n' '${operationId}' "$1" "$2" "$3"; }
set_step() { step=$1; printf '%s' "$step" > "$job/step"; emit_progress "$step" 0 0; }
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
${startsService ? servicePolicyFunctions + `private_failure() {
  reason=loopback_required
  printf '%s' "$reason" > "$job/reason"
  return 80
}
start_private_service() {
  service_private_config || { private_failure; return 80; }
  service_pending=true
  if run_step "$@"; then
    if ! service_private_listeners; then private_failure; return 80; fi
    service_pending=false
    return 0
  else return $?; fi
}
` : ""}set_step verifying
${instance.binaryHash ? `actual=$(sha256sum "$bin" | cut -d ' ' -f 1)\n[ "$actual" = ${shellQuote(instance.binaryHash)} ] || exit 79\n` : ""}${instance.unitHash ? `actual=$(sha256sum ${shellQuote(instance.unit)} | cut -d ' ' -f 1)\n[ "$actual" = ${shellQuote(instance.unitHash)} ] || exit 79\n` : ""}${startsService ? `systemctl --user daemon-reload >/dev/null 2>&1 || { private_failure; exit 80; }
${action === "enable_web" ? "service_overrides_clear" : "service_private_config"} || { private_failure; exit 80; }
` : ""}`;
  const uploadedRelease = ["install", "update"].includes(action) ? `command -v sha256sum >/dev/null
stage=$(mktemp -d "$base/upload.XXXXXXXX")
receive_binary() { cat > "$stage/magpie"; }
run_step uploading receive_binary
set_step verifying
printf '%s  %s\\n' ${shellQuote(release.sha256)} "$stage/magpie" | sha256sum -c - >/dev/null
chmod 755 "$stage/magpie"
run_step checking_upload "$stage/magpie" --version </dev/null
` : "";
  if (action === "install") {
    return prefix + `command -v magpie >/dev/null 2>&1 && exit 76
[ ! -e "$bin" ] && [ ! -L "$bin" ] || exit 76
${uploadedRelease}
set_step installing
mkdir -p "$HOME/.local/bin"
[ ! -e "$bin" ] && [ ! -L "$bin" ] || exit 76
replacement="$HOME/.local/bin/.magpie-${operationId}"
[ ! -e "$replacement" ] && [ ! -L "$replacement" ] || { replacement=''; exit 76; }
install -m 755 "$stage/magpie" "$replacement"
mv -n "$replacement" "$bin"
[ ! -e "$replacement" ] || exit 76
run_step checking_version "$bin" --version </dev/null
printf 'MIGPIE_DONE\\n'
`;
  }
  const selected = selectedBackup ? `root="$base/backups"
[ ! -L "$root" ] || exit 78
backup="$root/${selectedBackup.id}"
${backupInspection}inspect_backup || exit 79
[ "$fingerprint" = ${shellQuote(selectedBackup.fingerprint)} ] || exit 79
selected="$backup"
` : "";
  if (action === "delete_backup") return prefix + selected + `set_step deleting_backup
run_step deleting_backup rm -f "$selected/config.magpie" "$selected/config.tar.gz" "$selected/config.absent" "$selected/magpie" "$selected/version"
run_step deleting_backup rmdir "$selected"
printf 'MIGPIE_DONE\\n'
`;
  if (backupActions.includes(action)) {
    const mutation = action === "update" ? `set_step installing
target=$(readlink -f -- "$bin") || exit 78
[ -f "$target" ] && [ ! -L "$target" ] || exit 78
${instance.binaryHash ? `actual=$(sha256sum "$bin" | cut -d ' ' -f 1)\n[ "$actual" = ${shellQuote(instance.binaryHash)} ] || exit 79\n` : ""}replacement="$(dirname "$target")/.magpie-${operationId}"
[ ! -e "$replacement" ] && [ ! -L "$replacement" ] || { replacement=''; exit 76; }
run_step installing install -m 755 "$stage/magpie" "$replacement"
run_step installing mv -f -- "$replacement" "$target"
` : action === "restore" ? `set_step restoring
case "$format" in archive|absent) ;; *) exit 78 ;; esac
# Stage the archive beside the target, keeping extraction away from live files.
target=$(readlink -f -- "$config") || exit 78
[ -n "$target" ] && [ "$target" != / ] || exit 78
base_path=$(cd "$base" && pwd -P)
case "$base_path/" in "$target/"*) exit 78 ;; esac
case "$target/" in "$base_path/"*) exit 78 ;; esac
if [ -e "$target" ]; then [ -d "$target" ] && [ ! -L "$target" ] || exit 78; fi
restore_stage=$(mktemp -d "$(dirname "$target")/.magpie-restore.XXXXXXXX")
if [ "$format" = archive ]; then
  mkdir -m 700 "$restore_stage/config"
  extract_config() {
    tar -tzf "$selected/config.tar.gz" > "$job/archive-files" || return $?
    if LC_ALL=C grep -Eq '(^/|(^|/)\\.\\.(/|$))' "$job/archive-files"; then return 78; fi
    tar -xzf "$selected/config.tar.gz" --no-same-owner --no-same-permissions -C "$restore_stage/config"
  }
  run_step restoring extract_config
fi
${instance.service.state === "running" ? 'restore_service_state=unknown\nrun_step stopping "$bin" daemon stop </dev/null\nrestore_service_state=stopped\n' : ""}set_step restoring
if [ -d "$target" ]; then run_step restoring mv -- "$target" "$restore_stage/previous"; fi
if [ "$format" = archive ]; then run_step restoring mv -- "$restore_stage/config" "$target";
elif [ -L "$config" ]; then run_step restoring rm -- "$config"; fi
restore_applied=true
restore_config_state=applied
` : "";
    return prefix + uploadedRelease + selected + `command -v sha256sum >/dev/null
command -v tar >/dev/null
config=${shellQuote(instance.configDirectory)}
set_step preparing_backup
[ ! -L "$base/backups" ] || exit 78
mkdir -p "$base/backups"
backup="$base/backups/${operationId}"
mkdir -m 700 "$backup"
printf '%s' ${shellQuote(instance.version)} > "$backup/version"
set_step backing_up
if [ -d "$config" ]; then
  run_step backing_up tar -czf "$backup/config.tar.gz" -C "$config" .
  [ -s "$backup/config.tar.gz" ] || exit 77
elif [ -e "$config" ] || [ -L "$config" ]; then exit 77
else printf 'Configuration directory did not exist before this operation.\\n' > "$backup/config.absent"; fi
run_step saving_binary cp -p "$bin" "$backup/magpie"
backup_ready=true
${mutation}${action !== "backup" && instance.service.state === "running" ? `${action === "restore" ? "restore_service_state=unknown\n" : ""}start_private_service ${action === "restore" ? 'starting "$bin" daemon start' : 'restarting "$bin" daemon restart'} </dev/null\n` : ""}${action === "update" ? 'run_step checking_version "$bin" --version </dev/null\n' : ""}${action !== "backup" && instance.service.state === "running" ? `run_step healthcheck "$bin" healthcheck </dev/null\n${action === "restore" ? "restore_service_state=running\n" : ""}` : ""}printf 'MIGPIE_DONE\\n'
`;
  }
  if (action === "enable_web") return prefix + `service_pending=true
export MAGPIE_ADDR=127.0.0.1:3425
run_step enabling_web "$bin" daemon install --web --addr 127.0.0.1:3430 </dev/null
service_private_listeners || { private_failure; exit 80; }
service_pending=false
run_step healthcheck "$bin" healthcheck </dev/null
printf 'MIGPIE_DONE\\n'
`;
  if (["start", "stop", "restart"].includes(action)) return prefix + `${action === "stop" ? "run_step" : "start_private_service"} ${action === "start" ? "starting" : action === "stop" ? "stopping" : "restarting"} "$bin" daemon ${action} </dev/null
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
