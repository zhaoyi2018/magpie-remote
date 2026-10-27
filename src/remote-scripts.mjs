import { backupIdPattern, backupInspection } from "./remote-backups.mjs";

export const remoteActions = ["install", "update", "start", "stop", "restart", "enable_web", "backup", "restore", "delete_backup", "uninstall"];
export const backupActions = ["update", "backup", "restore"];

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
  const prefix = common + `bin=${bin}
job="$base/operations/${operationId}"
step=preparing
reason=command_failed
backup_ready=false
stage=''
restore_stage=''
restore_applied=false
${action === "restore" ? "restore_config_state=not_applied\nrestore_service_state=unchanged\nrestore_rollback_state=not_needed\n" : ""}finish() {
  code=$?
  trap - EXIT
  set +e
  rm -f "$job/output"
  if [ -n "$stage" ]; then rm -f "$stage/magpie"; rmdir "$stage"; fi
${restoreCleanup}  if [ -f "$job/step" ]; then step=$(cat "$job/step"); fi
  if [ -f "$job/reason" ]; then reason=$(cat "$job/reason"); fi
  state=failed
  if [ "$code" -eq 0 ]; then state=succeeded; step=completed; reason=none; fi
  result=$(printf 'MIGPIE_RESULT_V1\\t%s\\t%s\\t%s\\t%s\\t%s' '${operationId}' "$step" "$code" "$reason" "$backup_ready")
${restoreResult}  if [ -d "$job" ]; then
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
emit_progress() { printf 'MIGPIE_PROGRESS_V1\\t%s\\t%s\\t%s\\t%s\\n' '${operationId}' "$1" "$2" "$3"; }
set_step() { step=$1; printf '%s' "$step" > "$job/step"; emit_progress "$step" 0 0; }
sample_download() {
  current_bytes=''
  if [ "$step" = downloading ]; then
    if [ -f "$stage/magpie" ] && [ ! -L "$stage/magpie" ]; then current_bytes=$(stat -c %s "$stage/magpie" 2>/dev/null || true); fi
  else
    for candidate in "$download_bin.new" "$(dirname "$download_bin")/.magpie-update/$download_name.new" "\${XDG_CACHE_HOME:-$HOME/.cache}/magpie/update/$download_name.new" "$(dirname "$download_bin")/data/cache/update/$download_name.new"; do
      if [ -f "$candidate" ] && [ ! -L "$candidate" ] && [ "$candidate" -nt "$job/download-start" ]; then
        current_bytes=$(stat -c %s "$candidate" 2>/dev/null || true)
        break
      fi
    done
  fi
  case "$current_bytes" in ''|*[!0-9]*) return ;; esac
  emit_progress "$step" "$current_bytes" "$download_total"
}
run_step() {
  set_step "$1"
  shift
  if [ "$step" = downloading ] || [ "$step" = updating ]; then
    download_total=${action === "install" && Number.isSafeInteger(release?.size) && release.size > 0 ? release.size : 0}
    download_bin=$(readlink -f "$bin" 2>/dev/null || printf '%s' "$bin")
    download_name=\${download_bin##*/}
    : > "$job/download-start"
    "$@" > "$job/output" 2>&1 &
    command_pid=$!
    while kill -0 "$command_pid" 2>/dev/null; do sample_download; sleep 1; done
    sample_download
    if wait "$command_pid"; then rm -f "$job/output"; return 0; else code=$?; fi
    output=$(tail -c 16384 "$job/output")
    rm -f "$job/output"
  elif output=$("$@" 2>&1); then return 0; else code=$?; fi
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
    const mutation = action === "update" ? 'run_step updating "$bin" update </dev/null\n' : action === "restore" ? `set_step restoring
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
    return prefix + selected + `command -v sha256sum >/dev/null
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
${mutation}${action !== "backup" && instance.service.state === "running" ? `${action === "restore" ? "restore_service_state=unknown\n" : ""}run_step ${action === "restore" ? 'starting "$bin" daemon start' : 'restarting "$bin" daemon restart'} </dev/null\n` : ""}${action === "update" ? 'run_step checking_version "$bin" --version </dev/null\n' : ""}${action !== "backup" && instance.service.state === "running" ? `run_step healthcheck "$bin" healthcheck </dev/null\n${action === "restore" ? "restore_service_state=running\n" : ""}` : ""}printf 'MIGPIE_DONE\\n'
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
