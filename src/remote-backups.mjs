import { OperationError } from "./errors.mjs";

export const backupIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

// Inspect only fixed files in plugin-owned UUID directories; never follow links.
export const backupInspection = `inspect_backup() {
  [ -d "$backup" ] && [ ! -L "$backup" ] || return 1
  format=incomplete
  size=0
  fingerprint=''
  has_binary=false
  for file in config.magpie config.tar.gz config.absent magpie version; do
    path="$backup/$file"
    [ ! -L "$path" ] || return 1
    if [ -e "$path" ]; then
      [ -f "$path" ] || return 1
      bytes=$(wc -c < "$path" | tr -d '[:space:]')
      size=$((size + bytes))
      digest=$(sha256sum "$path" | cut -d ' ' -f 1) || return 1
      fingerprint="$fingerprint $file:$digest"
    fi
  done
  if [ -s "$backup/config.magpie" ]; then format=encrypted
  elif [ -s "$backup/config.tar.gz" ]; then format=archive
  elif [ -f "$backup/config.absent" ]; then format=absent; fi
  if [ -s "$backup/magpie" ]; then has_binary=true; fi
  fingerprint=$(printf '%s' "$fingerprint" | sha256sum | cut -d ' ' -f 1)
}
`;

export const backupInventoryScript = `set -eu
base="\${XDG_CONFIG_HOME:-$HOME/.config}/magpie-remote"
root="$base/backups"
[ ! -L "$root" ] || exit 78
printf 'MIGPIE_BACKUPS_V1\\n'
[ -d "$root" ] || exit 0
command -v sha256sum >/dev/null
${backupInspection}for backup in "$root"/*; do
  id=\${backup##*/}
  printf '%s' "$id" | grep -Eq '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' || continue
  inspect_backup || continue
  modified=$(stat -c %Y "$backup" 2>/dev/null || printf 0)
  version=''
  if [ -f "$backup/version" ]; then version=$(head -c 120 "$backup/version" | base64 | tr -d '\\r\\n'); fi
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$id" "$format" "$size" "$has_binary" "$modified" "$version" "$fingerprint"
done
`;

export function parseBackups(stdout, configDirectory) {
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.shift() !== "MIGPIE_BACKUPS_V1") throw new OperationError("REMOTE_BACKUPS_INVALID", "远端备份列表无效，请重新读取");
  const seen = new Set();
  return lines.map((line) => {
    const [id, format, bytes, binary, modified, version, fingerprint, extra] = line.split("\t");
    if (!backupIdPattern.test(id ?? "") || seen.has(id) || !["encrypted", "archive", "absent", "incomplete"].includes(format)
      || !/^\d{1,15}$/.test(bytes ?? "") || !["true", "false"].includes(binary) || !/^\d{1,12}$/.test(modified ?? "")
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(version ?? "") || (version?.length ?? 0) > 160
      || !/^[a-f0-9]{64}$/.test(fingerprint ?? "") || extra !== undefined) throw new OperationError("REMOTE_BACKUPS_INVALID", "远端备份条目无效，请重新读取");
    seen.add(id);
    const epoch = Number(modified) * 1000;
    return { id, directory: configDirectory.replace(/\/magpie$/, "/magpie-remote/backups/") + id, format, size: Number(bytes), hasBinary: binary === "true",
      createdAt: epoch > 0 && Number.isFinite(new Date(epoch).getTime()) ? new Date(epoch).toISOString() : null,
      version: Buffer.from(version, "base64").toString("utf8"), fingerprint };
  }).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.id.localeCompare(b.id));
}
