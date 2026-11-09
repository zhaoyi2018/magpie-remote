import { listenerScopeFunction } from "./remote-listeners.mjs";

// Accept native units with explicit loopback addresses. Unknown systemd syntax
// and overrides fail closed; nothing in the unit is evaluated as shell code.
export const servicePolicyFunctions = listenerScopeFunction + String.raw`
service_overrides_clear() {
  unit_paths=$(systemctl --user show --property=UnitPath --value 2>/dev/null) || return 1
  [ -n "$unit_paths" ] || return 1
  for dir in $unit_paths; do
    case "$dir" in /*) ;; *) return 1 ;; esac
    for dropin in "$dir/magpie.service.d/"*.conf "$dir/service.d/"*.conf; do
      [ ! -e "$dropin" ] && [ ! -L "$dropin" ] || return 1
    done
  done
  load=$(systemctl --user show magpie.service --property=LoadState --value 2>/dev/null) || [ "$load" = not-found ] || return 1
  case "$load" in loaded|not-found) ;; *) return 1 ;; esac
  fragment=$(unit_property FragmentPath) || return 1
  case "$fragment" in ''|"$unit") ;; *) return 1 ;; esac
  overrides=$(unit_property DropInPaths) || return 1
  [ -z "$overrides" ] || return 1
  envfiles=$(unit_property EnvironmentFiles) || return 1
  [ -z "$envfiles" ] || return 1
}
unit_property() {
  value=$(systemctl --user show magpie.service --property="$1" --value 2>/dev/null) || { [ "$load" = not-found ] && [ -z "$value" ] || return 1; }
  printf '%s' "$value"
}
service_config_ports() {
  [ -f "$unit" ] && [ ! -L "$unit" ] || return 1
  case "$bin" in *'%'*|*'\'*|*'"'*) return 1 ;; esac
  MAGPIE_AUDIT_BINARY="$bin" awk '
    function address(value, parts, n) {
      if (value !~ /^(127[.]0[.]0[.]1|\[::1\]):[0-9]+$/) return 0
      n = split(value, parts, ":"); return parts[n] + 0
    }
    /^[[:space:]]*([#;]|$)/ { next }
    /^\[(Unit|Service|Install)\]$/ { section = $0; next }
    section == "[Unit]" && /^(Description|Wants|After)=[^\\]*$/ { next }
    section == "[Install]" && /^WantedBy=[^\\]*$/ { next }
    section == "[Service]" && /^(Type=simple|Restart=on-failure|RestartSec=[0-9]+)$/ { next }
    section == "[Service]" && /^ExecStart=/ {
      value = $0; sub(/^ExecStart=/, "", value)
      prefix = "\"" ENVIRON["MAGPIE_AUDIT_BINARY"] "\" "
      if (index(value, prefix) != 1) { bad = 1; next }
      value = substr(value, length(prefix) + 1)
      sub(/^"serve"/, "serve", value)
      if (value != "serve") {
        if (index(value, "serve \"--web=") != 1 || substr(value, length(value)) != "\"") { bad = 1; next }
        value = substr(value, 14, length(value) - 14)
        web = address(value)
        if (web < 1 || web > 65535) bad = 1
      }
      starts++; next
    }
    section == "[Service]" && /^Environment="[A-Za-z_][A-Za-z0-9_]*=[^"\\%]*"$/ {
      if (index($0, "Environment=\"MAGPIE_ADDR=") == 1) {
        value = substr($0, 26, length($0) - 26)
        gateway_address = value
        gateway = address(value); gateways++
        if (gateway < 1 || gateway > 65535) bad = 1
      }
      next
    }
    { bad = 1 }
    END { if (bad || starts != 1 || gateways != 1) exit 1; print gateway, web + 0, gateway_address }
  ' "$unit"
}
service_private_config() {
  service_overrides_clear || return 1
  [ "$fragment" = "$unit" ] || return 1
  reload=$(systemctl --user show magpie.service --property=NeedDaemonReload --value 2>/dev/null) || return 1
  [ "$reload" = no ] || return 1
  service_ports=$(service_config_ports) || return 1
  set -- $service_ports
  MAGPIE_ADDR=$3
  export MAGPIE_ADDR
}
service_private_listeners() {
  service_private_config || return 1
  set -- $service_ports
  [ "$(listener_scope "$1")" = loopback ] || return 1
  if [ "$2" != 0 ]; then [ "$(listener_scope "$2")" = loopback ] || return 1; fi
}
`;
