import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { OperationError } from "./errors.mjs";
import { libraryHash, libraryLimitError, libraryLimits, parseLibraryJSON, resourcePath, selectLibraryResources } from "./remote-library.mjs";

const digestPattern = /^[a-f0-9]{64}$/;
const libraryMarker = "MIGPIE_LIBRARY_V1";
export const librarySnapshotMaxBytes = 14 * 1024 * 1024;

const pythonManifest = String.raw`import base64
import hashlib
import os
import re
import stat
import sys
from contextlib import contextmanager

config = os.fsencode(sys.argv[1])
instructions, skills = (arg == '1' for arg in sys.argv[2:])
count = total = 0
unsafe_rel = re.compile(rb'[\x00-\x1f\x7f\\:]')
gateway_pattern = re.compile(rb'"gatewayMode"[\t\v\f\r ]*:[\t\v\f\r ]*"on"')

def info(parent, name):
    try:
        return os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return None

@contextmanager
def directory(parent, name, readable=True):
    entry = info(parent, name)
    if entry is None:
        yield None
        return
    if not stat.S_ISDIR(entry.st_mode):
        raise OSError()
    flags = os.O_RDONLY if readable else os.O_PATH
    fd = os.open(name, flags | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        mode = os.R_OK | os.X_OK if readable else os.X_OK
        if not os.access(b'.', mode, dir_fd=fd, effective_ids=True):
            raise OSError()
        yield fd
    finally:
        os.close(fd)

@contextmanager
def regular(parent, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError()
        yield fd
    finally:
        os.close(fd)

def digest_file(parent, name, limit):
    sha = hashlib.sha256()
    size = 0
    with regular(parent, name) as fd:
        while True:
            data = os.read(fd, min(131072, limit + 1 - size))
            if not data:
                return size, sha.hexdigest()
            size += len(data)
            if size > limit:
                sys.exit(81)
            sha.update(data)

def child_order(name):
    # The POSIX walker expands *, .[!.]* and ..?* separately in C locale.
    return (2 if name.startswith(b'..') else 1 if name.startswith(b'.') else 0, name)

def scan_children(parent, relative, depth):
    for name in sorted(map(os.fsencode, os.listdir(parent)), key=child_order):
        scan_entry(parent, name, relative + b'/' + name, depth)

def scan_entry(parent, name, relative, depth):
    global count, total
    count += 1
    if count > ${libraryLimits.entries} or depth > ${libraryLimits.depth} or len(relative) > ${libraryLimits.path}:
        sys.exit(81)
    if unsafe_rel.search(relative) or any(part in (b'', b'.', b'..') for part in relative.split(b'/')):
        sys.exit(78)
    entry = info(parent, name)
    if entry is None:
        raise OSError()
    encoded = base64.b64encode(relative).decode('ascii')
    if stat.S_ISLNK(entry.st_mode):
        # readlink prints a newline before the shell appends its sentinel dot.
        digest = hashlib.sha256(os.readlink(name, dir_fd=parent) + b'\n.').hexdigest()
        print('L', encoded, digest, sep='\t')
    elif stat.S_ISDIR(entry.st_mode):
        if relative == b'library/instructions.md':
            sys.exit(78)
        with directory(parent, name) as child:
            if child is None:
                raise OSError()
            print('D', encoded, '-', sep='\t')
            scan_children(child, relative, depth + 1)
    elif stat.S_ISREG(entry.st_mode):
        size, digest = digest_file(parent, name, min(${libraryLimits.file}, ${libraryLimits.bytes} - total))
        total += size
        executable = os.access(name, os.X_OK, dir_fd=parent, effective_ids=True, follow_symlinks=False)
        print('X' if executable else 'F', encoded, digest, sep='\t')
    else:
        sys.exit(78)

def gateway_enabled(parent):
    if os.environ.get('MAGPIE_GATEWAY') == '1':
        return True
    if parent is None:
        return False
    try:
        entry = info(parent, b'settings.json')
        if entry is not None and stat.S_ISREG(entry.st_mode):
            with regular(parent, b'settings.json') as fd, os.fdopen(fd, 'rb', closefd=False) as settings:
                return bool(gateway_pattern.search(settings.read(${libraryLimits.json})))
    except OSError:
        pass  # An unreadable settings file did not match the shell's grep.
    return False

def manifest():
    with directory(None, config) as root:
        json = None if root is None else info(root, b'library.json')
        if json is None:
            print('J', 0, '-', sep='\t')
        else:
            if not stat.S_ISREG(json.st_mode):
                sys.exit(78)
            size, digest = digest_file(root, b'library.json', ${libraryLimits.json})
            print('J', size, digest, sep='\t')
        print('G', 'true' if gateway_enabled(root) else 'false', sep='\t')
        if root is None or not (instructions or skills):
            return
        with directory(root, b'library', readable=False) as library:
            if library is None:
                return
            if instructions and info(library, b'instructions.md') is not None:
                scan_entry(library, b'instructions.md', b'library/instructions.md', 1)
            for selected, name in ((instructions, b'instruction-sets'), (skills, b'skills')):
                if selected:
                    with directory(library, name) as tree:
                        if tree is not None:
                            scan_children(tree, b'library/' + name, 1)

try:
    manifest()
except OSError:
    sys.exit(78)
`;

function scanFunctions(categories) {
  return `LC_ALL=C
export LC_ALL
present() { [ -e "$1" ] || [ -L "$1" ]; }
safe_dir() { [ ! -L "$1" ] && { [ ! -e "$1" ] || [ -d "$1" ]; }; }
bytes_of() { wc -c < "$1" | tr -d '[:space:]'; }
hash_file() { sha256sum < "$1" | cut -d ' ' -f 1; }
encode() { base64 | tr -d '\\r\\n'; }
valid_rel() {
  case "$1" in ''|/*|*/|*//*|*\\\\*|*:*) return 1 ;; esac
  case "/$1/" in */../*|*/./*) return 1 ;; esac
  # grep consumes line separators before testing for control bytes.
  case "$1" in *'
'*) return 1 ;; esac
  ! printf '%s' "$1" | grep -q '[[:cntrl:]]'
}
scan_entry() {
  count=$((count + 1))
  [ "$count" -le ${libraryLimits.entries} ] && [ "$3" -le ${libraryLimits.depth} ] && [ "\${#2}" -le ${libraryLimits.path} ] || exit 81
  valid_rel "$2" || exit 78
  if [ -L "$1" ]; then
    link=$(readlink -- "$1" && printf '.') || exit 78
    printf 'L\\t%s\\t%s\\n' "$(printf '%s' "$2" | encode)" "$(printf '%s' "$link" | sha256sum | cut -d ' ' -f 1)"
  elif [ -d "$1" ]; then
    [ "$2" != library/instructions.md ] && [ -x "$1" ] && [ -r "$1" ] || exit 78
    printf 'D\\t%s\\t-\\n' "$(printf '%s' "$2" | encode)"
    for child in "$1"/* "$1"/.[!.]* "$1"/..?*; do
      if present "$child"; then scan_entry "$child" "$2/\${child##*/}" "$(( $3 + 1 ))"; fi
    done
  elif [ -f "$1" ]; then
    size=$(bytes_of "$1")
    case "$size" in ''|*[!0-9]*) exit 78 ;; esac
    [ "$size" -le ${libraryLimits.file} ] || exit 81
    total=$((total + size))
    [ "$total" -le ${libraryLimits.bytes} ] || exit 81
    digest=$(hash_file "$1")
    [ "\${#digest}" -eq 64 ] || exit 78
    if [ -x "$1" ]; then kind=X; else kind=F; fi
    printf '%s\\t%s\\t%s\\n' "$kind" "$(printf '%s' "$2" | encode)" "$digest"
  else exit 78; fi
}
scan_tree() {
  safe_dir "$config/$1" || exit 78
  [ -d "$config/$1" ] || return 0
  [ -x "$config/$1" ] && [ -r "$config/$1" ] || exit 78
  for item in "$config/$1"/* "$config/$1"/.[!.]* "$config/$1"/..?*; do
    if present "$item"; then scan_entry "$item" "$1/\${item##*/}" 1; fi
  done
}
scan_json() {
  safe_dir "$config" || exit 78
  if [ -d "$config" ]; then [ -r "$config" ] && [ -x "$config" ] || exit 78; fi
  if present "$config/library.json"; then
    [ -f "$config/library.json" ] && [ ! -L "$config/library.json" ] || exit 78
    json_size=$(bytes_of "$config/library.json")
    case "$json_size" in ''|*[!0-9]*) exit 78 ;; esac
    [ "$json_size" -le ${libraryLimits.json} ] || exit 81
    digest=$(hash_file "$config/library.json")
    [ "\${#digest}" -eq 64 ] || exit 78
    printf 'J\\t%s\\t%s\\n' "$json_size" "$digest"
  else printf 'J\\t0\\t-\\n'; fi
}
library_manifest_sh() {
  count=0 total=0
  scan_json
  gateway=false
  if [ "\${MAGPIE_GATEWAY:-}" = 1 ] || { [ -f "$config/settings.json" ] && [ ! -L "$config/settings.json" ] && head -c ${libraryLimits.json} "$config/settings.json" | grep -Eq '"gatewayMode"[[:space:]]*:[[:space:]]*"on"'; }; then gateway=true; fi
  printf 'G\\t%s\\n' "$gateway"
${categories.some((category) => ["instructions", "skills"].includes(category)) ? '  safe_dir "$config/library" || exit 78\n  if [ -d "$config/library" ]; then [ -x "$config/library" ] || exit 78; fi\n' : ""}${categories.includes("instructions") ? `  if present "$config/library/instructions.md"; then scan_entry "$config/library/instructions.md" 'library/instructions.md' 1; fi
  scan_tree library/instruction-sets
` : ""}${categories.includes("skills") ? "  scan_tree library/skills\n" : ""}}
library_manifest() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -I -S -B - "$config" ${Number(categories.includes("instructions"))} ${Number(categories.includes("skills"))} <<'MIGPIE_LIBRARY_PYTHON'
${pythonManifest}MIGPIE_LIBRARY_PYTHON
  else
    library_manifest_sh
  fi
}
`;
}

export function librarySnapshotScript(instance, categories) {
  return `set -eu
config="\${XDG_CONFIG_HOME:-$HOME/.config}/magpie"
[ "$config" = ${quote(instance.configDirectory)} ] || exit 82
${librarySnapshotBody(categories)}`;
}

// The standalone script checks the path from the earlier SSH probe. The
// combined script uses the same shell variable that it just reported.
export function librarySnapshotBody(categories) {
  return `exec 2>/dev/null
${scanFunctions(categories)}manifest=$(library_manifest)
printf '${libraryMarker}\\n%s\\n' "$manifest"
printf 'C\\t'
if [ -f "$config/library.json" ] && [ ! -L "$config/library.json" ]; then head -c ${libraryLimits.json + 1} "$config/library.json" | encode; fi
printf '\\n'
`;
}

const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";

export function parseLibrarySnapshot(stdout, categories) {
  const protocol = () => new OperationError("REMOTE_LIBRARY_PROTOCOL", "远端资源库快照响应无效，请重新检测后预览");
  function decode(text) {
    const bytes = Buffer.from(text, "base64");
    if (bytes.toString("base64") !== text) throw protocol();
    return bytes;
  }
  const lines = stdout.split(/\r?\n/);
  if (lines.shift() !== libraryMarker || lines.pop() !== "") throw protocol();
  const data = lines.pop();
  if (!data?.startsWith("C\t")) throw protocol();
  const [json, gateway, ...rows] = lines;
  const match = json?.match(/^J\t(0|[1-9]\d{0,6})\t(-|[a-f0-9]{64})$/);
  if (!match || !["G\tfalse", "G\ttrue"].includes(gateway) || rows.length > libraryLimits.entries) throw protocol();
  const [, size, digest] = match, bytes = decode(data.slice(2));
  if (bytes.length > libraryLimits.json) throw libraryLimitError();
  if (Number(size) !== bytes.length || (digest === "-" ? bytes.length !== 0 : digest !== libraryHash(bytes))) {
    throw new OperationError("REMOTE_PREVIEW_STALE", "读取时远端资源库发生变化，请重新预览");
  }
  const entries = new Map(), manifestRows = new Map();
  for (const line of rows) {
    const [kind, encoded, digest, extra] = line.split("\t");
    if (!encoded || extra !== undefined || (kind === "D" ? digest !== "-" : !["F", "X", "L"].includes(kind) || !digestPattern.test(digest ?? ""))) throw protocol();
    let path;
    try { path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(decode(encoded)); }
    catch { throw protocol(); }
    const resource = resourcePath(path);
    if (!resource || !categories.includes(resource.category) || entries.has(path)) throw protocol();
    if (path !== resource.group && entries.get(path.slice(0, path.lastIndexOf("/")))?.kind !== "D") throw protocol();
    entries.set(path, { kind, ...(kind !== "D" && { digest }) });
    manifestRows.set(path, line);
  }
  return remoteLibrarySnapshot({ config: digest === "-" ? {} : parseLibraryJSON(bytes), entries, manifestHeader: [json, gateway], manifestRows, gateway: gateway === "G\ttrue" });
}

function remoteLibrarySnapshot(snapshot) {
  return { ...snapshot, fingerprint: libraryHash([...snapshot.manifestHeader, ...snapshot.manifestRows.values()].join("\n")) };
}

export function selectRemoteLibrary(snapshot, categories) {
  return remoteLibrarySnapshot({ ...snapshot, entries: selectLibraryResources(snapshot.entries, categories), manifestRows: selectLibraryResources(snapshot.manifestRows, categories) });
}

// The archive contains only fixed or numbered regular files. User paths are
// records inside it and are applied separately after checksum verification.
function tarEntry(name, data) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "ascii");
  header.write("0000600\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(32, 148, 156);
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return [header, data, Buffer.alloc((512 - data.length % 512) % 512)].filter((part) => part.length);
}

export function libraryBundle(plan) {
  const operations = [], members = [], files = [];
  function add(path, entries) {
    const id = operations.length;
    operations.push(`${entries ? "P" : "R"}\t${id}\t${path}\n`);
    if (!entries) return;
    for (const [member, { kind, content }] of entries) {
      const relative = member === path ? "." : member.slice(path.length + 1);
      const file = kind === "D" ? "-" : files.length;
      if (kind !== "D") files.push(content);
      members.push(`${kind}\t${id}\t${file}\t${relative}\n`);
    }
  }
  for (const [path, entries] of plan.mutations) add(path, entries);
  if (plan.configChanged) {
    const content = Buffer.from(JSON.stringify(plan.config, null, 2) + "\n");
    if (content.length > libraryLimits.json) throw libraryLimitError();
    add("library.json", new Map([["library.json", { kind: "F", content }]]));
  }
  if (operations.length > 2 * libraryLimits.entries + 1 || members.length > libraryLimits.entries + 1) throw libraryLimitError();
  const chunks = [
    ...tarEntry("plan", Buffer.from(operations.join(""))),
    ...tarEntry("members", Buffer.from(members.join(""))),
    ...files.flatMap((content, index) => tarEntry(`files/${index}`, content)),
    Buffer.alloc(1024),
  ];
  let size = 0;
  const sha256 = createHash("sha256");
  for (const chunk of chunks) { size += chunk.length; sha256.update(chunk); }
  return { size, sha256: sha256.digest("hex"), stream: () => Readable.from(chunks) };
}

export const libraryScriptVariables = `library_stage=''
library_config_state=not_applied
library_sync_state=not_started
job_created=false
`;

export const libraryScriptCleanup = `  if [ -n "$library_stage" ]; then
    if [ "$library_config_state" = unknown ]; then
      if rollback_library; then library_config_state=rolled_back; fi
    fi
    if [ "$library_config_state" != unknown ]; then rm -rf --one-file-system -- "$library_stage";
    else rm -rf --one-file-system -- "$library_stage/new" "$library_stage/bundle"; fi
  fi
`;

export function libraryScriptResult(id) {
  return `  library_result=$(printf 'MIGPIE_LIBRARY_RESULT_V1\\t%s\\t%s\\t%s' '${id}' "$library_config_state" "$library_sync_state")
  result=$(printf '%s\\n%s' "$result" "$library_result")
`;
}

export function libraryReceiveScript(instance, { sha256, size, remote, options }) {
  if (!digestPattern.test(sha256) || !digestPattern.test(remote.fingerprint) || !Number.isSafeInteger(size)
    || size < 1024 || size > 80 * 1024 * 1024) throw libraryLimitError();
  return `config=${quote(instance.configDirectory)}
[ "$config" = "\${XDG_CONFIG_HOME:-$HOME/.config}/magpie" ] || { reason=stale_library; exit 82; }
${scanFunctions(options.categories)}verify_library() {
  reason=unsafe_library
  manifest=$(library_manifest) || { code=$?; [ "$code" -ne 81 ] || reason=library_limit; return "$code"; }
  actual=$(printf '%s' "$manifest" | sha256sum | cut -d ' ' -f 1)
  if [ "$actual" != '${remote.fingerprint}' ]; then reason=stale_library; return 82; fi
  reason=command_failed
}
verify_library
library_stage=$(mktemp -d "$(dirname "$config")/.magpie-library.XXXXXXXX")
set_step uploading
head -c ${size + 1} > "$library_stage/payload.tar"
set_step checking_upload
reason=library_checksum
[ "$(bytes_of "$library_stage/payload.tar")" -eq ${size} ] && [ "$(hash_file "$library_stage/payload.tar")" = '${sha256}' ] || exit 84
reason=unsafe_library
mkdir "$library_stage/bundle" "$library_stage/new" "$library_stage/old" "$library_stage/touched" "$library_stage/created"
tar -xf "$library_stage/payload.tar" --no-same-owner --no-same-permissions -C "$library_stage/bundle"
rm -- "$library_stage/payload.tar"
bundle="$library_stage/bundle"
tab=$(printf '\\t')
valid_target() {
  case "$1" in
    library.json) return 0 ;;
${options.categories.includes("instructions") ? `    library/instructions.md) return 0 ;;
    library/instruction-sets/*) target_name=\${1#library/instruction-sets/} ;;
` : ""}${options.categories.includes("skills") ? '    library/skills/*) target_name=${1#library/skills/} ;;\n' : ""}    *) return 1 ;;
  esac
  case "$target_name" in */*) return 1 ;; esac
  valid_rel "$target_name"
}
number() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; }
[ -f "$bundle/plan" ] && [ ! -L "$bundle/plan" ] && [ -f "$bundle/members" ] && [ ! -L "$bundle/members" ] && safe_dir "$bundle/files" || exit 78
while IFS="$tab" read -r kind id file path; do
  number "$id" || exit 78
  if [ "$path" = . ]; then target="$library_stage/new/$id"
  else valid_rel "$path" || exit 78; target="$library_stage/new/$id/$path"; fi
  case "$kind" in
    D) mkdir -- "$target" ;;
    F|X)
      number "$file" && [ -f "$bundle/files/$file" ] && [ ! -L "$bundle/files/$file" ] || exit 78
      mv -T -- "$bundle/files/$file" "$target"
      if [ "$kind" = X ]; then chmod 700 "$target"; else chmod 600 "$target"; fi ;;
    *) exit 78 ;;
  esac
done < "$bundle/members"
while IFS="$tab" read -r op id rel; do
  number "$id" && valid_target "$rel" || exit 78
  case "$op" in
    P) present "$library_stage/new/$id" || exit 78 ;;
    R) [ "$rel" != library.json ] || exit 78 ;;
    *) exit 78 ;;
  esac
done < "$bundle/plan"
reason=command_failed
`;
}

export function libraryCommitScript(instance) {
  return `set_step applying_library
verify_library
expected_json=$(printf '%s\\n' "$manifest" | head -n 1)
verify_library_json() {
  actual_json=$(scan_json) || { code=$?; reason=unsafe_library; [ "$code" -ne 81 ] || reason=library_limit; return "$code"; }
  if [ "$actual_json" != "$expected_json" ]; then reason=stale_library; return 82; fi
}
move_once() {
  mv -T -n -- "$1" "$2" && ! present "$1"
}
safe_target_parent() {
  safe_dir "$config" || return 1
  case "$1" in library/*) safe_dir "$config/library" || return 1 ;; esac
  case "$1" in
    library/skills/*) safe_dir "$config/library/skills" || return 1 ;;
    library/instruction-sets/*) safe_dir "$config/library/instruction-sets" || return 1 ;;
  esac
}
ensure_dir() {
  safe_dir "$config/$1" || return 1
  if [ ! -d "$config/$1" ]; then
    mkdir -- "$config/$1" || return 1
    printf '%s' created > "$library_stage/created/$2"
  fi
}
rollback_library() {
  rollback_ok=true
  while IFS="$tab" read -r rollback_op rollback_id rollback_rel; do
    [ -f "$library_stage/touched/$rollback_id" ] || continue
    safe_target_parent "$rollback_rel" || { rollback_ok=false; continue; }
    rollback_target="$config/$rollback_rel"
    if [ "$rollback_rel" = library.json ]; then
      if ! present "$library_stage/new/$rollback_id"; then
        if present "$library_stage/old/$rollback_id"; then
          mv -Tf -- "$library_stage/old/$rollback_id" "$rollback_target" || rollback_ok=false
        else move_once "$rollback_target" "$library_stage/new/$rollback_id" || rollback_ok=false; fi
      fi
      continue
    fi
    if [ "$rollback_op" = P ] && ! present "$library_stage/new/$rollback_id"; then
      move_once "$rollback_target" "$library_stage/new/$rollback_id" || { rollback_ok=false; continue; }
    fi
    if present "$library_stage/old/$rollback_id"; then
      move_once "$library_stage/old/$rollback_id" "$rollback_target" || rollback_ok=false
    fi
  done < "$bundle/plan"
  for dir in library/skills library/instruction-sets library .; do
    case "$dir" in library/skills) mark=skills ;; library/instruction-sets) mark=sets ;; library) mark=library ;; *) mark=config ;; esac
    if [ -f "$library_stage/created/$mark" ]; then
      if [ "$dir" = . ]; then rmdir -- "$config" || rollback_ok=false;
      else rmdir -- "$config/$dir" || rollback_ok=false; fi
    fi
  done
  [ "$rollback_ok" = true ]
}
if [ -s "$bundle/plan" ]; then
  library_config_state=unknown
  if [ ! -d "$config" ]; then
    mkdir -- "$config"
    printf '%s' created > "$library_stage/created/config"
  fi
  device=$(stat -c %d "$library_stage")
  json_replaced=false
  while IFS="$tab" read -r op id rel; do
    reason=unsafe_library
    safe_dir "$config" || exit 78
    case "$rel" in
      library/*)
        ensure_dir library library || exit 78
        case "$rel" in
          library/skills/*) ensure_dir library/skills skills || exit 78 ;;
          library/instruction-sets/*) ensure_dir library/instruction-sets sets || exit 78 ;;
        esac ;;
    esac
    target="$config/$rel"
    [ "$(stat -c %d "$(dirname "$target")")" = "$device" ] || exit 78
    reason=command_failed
    printf '%s' touched > "$library_stage/touched/$id"
    if [ "$rel" = library.json ]; then
      verify_library_json
      if present "$target"; then
        [ -f "$target" ] && [ ! -L "$target" ] || { reason=unsafe_library; exit 78; }
        cp -p -- "$target" "$library_stage/old/$id"
        verify_library_json
        mv -Tf -- "$library_stage/new/$id" "$target"
      else move_once "$library_stage/new/$id" "$target"; fi
      json_replaced=true
    else
      if present "$target"; then move_once "$target" "$library_stage/old/$id"; fi
      if [ "$op" = P ]; then move_once "$library_stage/new/$id" "$target"; fi
    fi
  done < "$bundle/plan"
  if [ "$json_replaced" = false ]; then verify_library_json; fi
fi
library_config_state=applied
${instance.capabilities.includes("library_sync") ? `set_step syncing_library
library_sync_state=unknown
if output=$("$bin" library sync </dev/null 2>&1); then
  if printf '%s\\n' "$output" | grep -Fq 'library written into'; then library_sync_state=synced
  elif printf '%s\\n' "$output" | grep -Eiq 'gateway mode: the agents are on other computers'; then library_sync_state=gateway_mode
  elif printf '%s\\n' "$output" | grep -Eiq 'no (supported )?agents (found|to tell)'; then library_sync_state=no_agents
  elif printf '%s\\n' "$output" | grep -Fq 'every agent already has it'; then
    if printf '%s\\n' "$manifest" | grep -Fqx "G\${tab}true"; then library_sync_state=gateway_mode
    elif agents=$("$bin" ls </dev/null 2>&1) && { [ -z "$agents" ] || printf '%s\\n' "$agents" | grep -Fq 'no supported agents found on this machine'; }; then library_sync_state=no_agents
    else library_sync_state=unchanged; fi
  else library_sync_state=synced; fi
else
  code=$?
  library_sync_state=failed
  reason=library_sync_failed
  exit "$code"
fi
unset output agents
` : "library_sync_state=unsupported\n"}printf 'MIGPIE_DONE\\n'
`;
}
