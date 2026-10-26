import { join } from "node:path";
import { identifier, pluginOptions, validateForward, validateProfile } from "./config.mjs";
import { ProfileStore, assertProfileRevision, profileRevision, publicProfile } from "./store.mjs";
import { SessionManager } from "./sessions.mjs";
import { startManagementServer, publishEndpoint } from "./web-server.mjs";
import { fileURLToPath } from "node:url";
import { readSSHConfig } from "./ssh-config.mjs";
import { OperationError } from "./errors.mjs";
import { RemoteManager } from "./remote.mjs";
import { remoteActions } from "./remote-scripts.mjs";

const runtimes = new WeakMap();
export async function closePlugin(hooks) {
  const runtime = runtimes.get(hooks);
  if (runtime) {
    runtime.startup.abort();
    await runtime.startupTask;
    await runtime.web?.close();
    await runtime.sessions.close();
    await runtime.remote.close();
    runtimes.delete(hooks);
  }
}

const idSchema = { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$" };
const stringSchema = { type: "string", minLength: 1 };
const portSchema = { type: "integer", minimum: 1, maximum: 65535 };
const revisionSchema = { type: "string", pattern: "^[a-f0-9]{64}$", description: "The revision returned by connections for this profile; reread and reconcile on CONFIG_CONFLICT" };
const forwardSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "direction", "bindPort", "targetPort"],
  properties: {
    id: idSchema,
    name: { ...stringSchema, maxLength: 100, description: "Optional display name for the forward" },
    direction: { type: "string", enum: ["c2s", "s2c"], description: "c2s = SSH -L; s2c = SSH -R" },
    bindHost: { ...stringSchema, default: "127.0.0.1" },
    bindPort: { type: "integer", minimum: 0, maximum: 65535, description: "0 selects an available port" },
    targetHost: { ...stringSchema, default: "127.0.0.1" },
    targetPort: portSchema,
  },
};
const profileSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "host", "username"],
  properties: {
    id: idSchema, name: stringSchema, host: stringSchema, username: stringSchema,
    port: { ...portSchema, default: 22 },
    authMethod: { type: "string", enum: ["password", "agent", "key", "environment"], description: "Preferred authentication method; password uses the locally encrypted saved password" },
    autoStartForwards: { type: "boolean", default: true, description: "Start saved forward presets after successful authentication" },
    autoConnect: { type: "boolean", default: false, description: "Try connecting once when the plugin host starts using available saved authentication sources" },
    autoReconnect: { type: "boolean", default: false, description: "Retry network failures with capped exponential backoff; manual disconnect cancels retries and temporary credentials are never retained" },
    forwardFailurePolicy: { type: "string", enum: ["rollback", "continue"], default: "rollback", description: "Whether a rejected preset rolls back the connection or allows other presets to continue; uncertain remote allocations always close SSH" },
    identityFile: { ...stringSchema, description: "Absolute path or ~/ path to an SSH private key; never its contents" },
    agent: { ...stringSchema, description: "SSH agent socket or Windows named pipe" },
    passwordEnv: { ...stringSchema, description: "Environment variable name containing the password" },
    passphraseEnv: { ...stringSchema, description: "Environment variable name containing the key passphrase" },
    knownHostsFile: { ...stringSchema, description: "Defaults to ~/.ssh/known_hosts" },
    hostFingerprint: { type: "string", pattern: "^SHA256:[A-Za-z0-9+/]{43}$" },
    forwards: { type: "array", items: forwardSchema, default: [] },
  },
};

function args(properties, required = Object.keys(properties)) {
  return { type: "object", properties, required, additionalProperties: false };
}

export function createTools(store, sessions, remote = new RemoteManager({ store, sessions })) {
  sessions.passwordVault ??= store.passwordVault;
  // Serialize configuration and session mutations for each profile, while allowing
  // independent connections to proceed in parallel in Magpie's shared host.
  const operations = new Map();
  const pendingConnects = new Map();
  const remoteSubmissions = new Set();
  let restoring = false;
  const assertMutable = () => {
    if (restoring) throw new OperationError("CONFIG_RESTORE_BUSY", "正在恢复配置，请稍后重试");
  };
  const assertForwardEditable = (id) => {
    if (["waiting", "connecting"].includes(sessions.status(id).reconnect?.state)) throw new OperationError("SESSION_BUSY", "请先停止连接或自动重连，再修改转发预设");
  };
  const serial = (id, action) => {
    identifier(id);
    assertMutable();
    const operation = (operations.get(id) ?? Promise.resolve()).catch(() => {}).then(() => { assertMutable(); return action(); });
    operations.set(id, operation);
    void operation.finally(() => {
      if (operations.get(id) === operation) operations.delete(id);
    }).catch(() => {});
    return operation;
  };
  return {
    remote_status: {
      description: "Read remote Magpie state and the latest operation. refresh=true explicitly probes the connected remote user; it never installs or changes Magpie. Cached state is marked stale when SSH disconnects.",
      args: args({ connectionId: idSchema, refresh: { type: "boolean", default: false } }, ["connectionId"]),
      execute({ connectionId, refresh = false }, ctx = {}) {
        if (typeof refresh !== "boolean") throw new Error("refresh 必须是布尔值");
        const read = () => remote.status(connectionId, { refresh, signal: ctx.abort });
        return refresh ? serial(connectionId, read) : read();
      },
    },
    remote_preview: {
      description: "Probe and preview a named remote Magpie lifecycle action. Returns a short-lived revision and exact changes/warnings. Does not modify the remote machine. Linux only.",
      args: args({ connectionId: idSchema, action: { type: "string", enum: remoteActions } }),
      execute({ connectionId, action }, ctx = {}) { return serial(connectionId, () => remote.preview(connectionId, action, { signal: ctx.abort })); },
    },
    remote_apply: {
      description: "Start a previously previewed remote Magpie action using its revision and return a background operation immediately. Query remote_status for progress; never retry an unknown result. The preview selects official encrypted backup or a clearly disclosed local config archive; encrypted backups require a passphrase entered separately on the management page.",
      args: args({ connectionId: idSchema, action: { type: "string", enum: remoteActions }, revision: { ...revisionSchema, description: "The short-lived revision returned by remote_preview for this action" } }),
      execute({ connectionId, action, revision }, ctx = {}) {
        return serial(connectionId, async () => {
          const submission = remote.apply(connectionId, action, revision, ctx.credentials);
          remoteSubmissions.add(submission);
          try { return await submission; }
          finally { remoteSubmissions.delete(submission); }
        });
      },
    },
    remote_operation: {
      description: "Read the latest remote operation for this connection, including failed or unknown results. Never returns credentials or raw command output.",
      args: args({ connectionId: idSchema, operationId: stringSchema }, ["connectionId"]),
      execute({ connectionId, operationId }) { return remote.operation(connectionId, operationId); },
    },
    remote_web: {
      description: "Explicitly obtain a remote Magpie Web sign-in link through a loopback SSH forward. The returned link grants remote management access: do not log or share it. SSH must stay connected.",
      args: args({ connectionId: idSchema, port: portSchema }, ["connectionId"]),
      execute({ connectionId, port }) { return serial(connectionId, () => remote.web(connectionId, { port })); },
    },
    config_backups: {
      description: "List local configuration backup metadata, even when the current configuration is damaged. Never returns credentials or backup contents.",
      args: args({}),
      execute() { return store.listBackups(); },
    },
    config_backup: {
      description: "Create a validated local configuration backup. Retains the latest five valid snapshots; saved passwords remain encrypted and the local encryption key is never included.",
      args: args({}),
      execute() { assertMutable(); return store.createBackup(); },
    },
    config_restore_preview: {
      description: "Preview the connections in a selected backup and those that will be removed. Returns a revision required for restore; does not change files or sessions.",
      args: args({ backupId: stringSchema }),
      execute({ backupId }) { return store.previewRestore(backupId); },
    },
    config_restore: {
      description: "Restore an explicitly previewed backup, preserving the previous configuration. Requires stopConnections=true when sessions or retries are active; cancels them and never auto-connects restored profiles. Rejects stale previews.",
      args: args({ backupId: stringSchema, revision: { type: "string", pattern: "^[a-f0-9]{64}$" }, stopConnections: { type: "boolean", default: false } }, ["backupId", "revision"]),
      async execute({ backupId, revision, stopConnections = false }) {
        assertMutable();
        if (typeof stopConnections !== "boolean") throw new Error("stopConnections 必须是布尔值");
        restoring = true;
        try {
          // An accepted submission must publish its task before restore decides
          // whether it may disconnect SSH. Queued connects still cancel below.
          await Promise.allSettled([...remoteSubmissions]);
          await remote.assertAllIdle();
          const preview = await store.previewRestore(backupId);
          if (revision !== preview.revision) throw new OperationError("CONFIG_RESTORE_STALE", "配置或备份已变化，请重新预览后恢复");
          if (!stopConnections && (pendingConnects.size || sessions.status().some((session) => sessions.isActive(session.id)))) throw new OperationError("CONFIG_RESTORE_ACTIVE", "请先断开所有连接并停止自动重连，或明确选择停止连接后恢复");
          for (const pending of pendingConnects.values()) for (const controller of pending) controller.abort();
          await sessions.disconnectAll();
          await Promise.allSettled([...operations.values()]);
          return await store.restore(backupId, revision);
        } finally { restoring = false; }
      },
    },
    ssh_config_preview: {
      description: "Preview concrete hosts from the local user's and system OpenSSH configuration, or one specified file. Reads Include files without executing commands or connecting. Existing profiles are marked and not overwritten.",
      args: args({ configPath: stringSchema }, []),
      async execute({ configPath } = {}) {
        const preview = await readSSHConfig({ configPath });
        const ids = new Set((await store.list()).map((profile) => profile.id));
        return { ...preview, candidates: preview.candidates.map((candidate) => ({ ...candidate, exists: Boolean(candidate.profile && ids.has(candidate.profile.id)) })) };
      },
    },
    ssh_config_import: {
      description: "Import only explicitly selected aliases from a previously previewed OpenSSH configuration revision. Creates new profiles atomically, skips existing IDs, never connects, and optionally includes TCP forward presets.",
      args: args({ configPath: stringSchema, revision: { type: "string", pattern: "^[a-f0-9]{64}$" }, aliases: { type: "array", minItems: 1, maxItems: 500, uniqueItems: true, items: stringSchema }, includeForwards: { type: "boolean", default: true } }, ["revision", "aliases"]),
      async execute({ configPath, revision, aliases, includeForwards = true }) {
        assertMutable();
        if (!Array.isArray(aliases) || !aliases.length || aliases.length > 500 || aliases.some((alias) => typeof alias !== "string") || new Set(aliases).size !== aliases.length) throw new Error("请勾选 1–500 个不同的 SSH 主机");
        if (typeof includeForwards !== "boolean") throw new Error("includeForwards 必须是布尔值");
        const preview = await readSSHConfig({ configPath });
        if (preview.revision !== revision) throw new Error("SSH 配置已变化，请重新预览后再导入");
        const candidates = new Map(preview.candidates.map((candidate) => [candidate.alias, candidate]));
        const profiles = aliases.map((alias) => {
          const candidate = candidates.get(alias);
          if (!candidate?.selectable) throw new Error(`主机 ${alias} 不在可导入列表中，请重新预览`);
          return { ...candidate.profile, forwards: includeForwards ? candidate.profile.forwards : [] };
        });
        assertMutable();
        return store.importProfiles(profiles);
      },
    },
    connections: {
      description: "List saved SSH profiles as {connection, revision, hasSavedPassword, session}, without passwords or ciphertext. Use each profile's revision as expectedRevision when editing or deleting its configuration. Does not connect.",
      args: args({}),
      async execute() {
        return (await store.list()).map((profile) => ({ connection: publicProfile(profile), revision: profileRevision(profile), hasSavedPassword: Boolean(profile.encryptedPassword), session: sessions.status(profile.id) }));
      },
    },
    save_connection: {
      description: "Create or replace an SSH profile and return {connection, revision, hasSavedPassword}. Existing profiles require expectedRevision. Password authentication preserves an existing encrypted password; new passwords are supplied by the local management page separately from profile fields. Never returns passwords or ciphertext. Disconnect before updating an active profile.",
      args: args({ connection: profileSchema, expectedRevision: { anyOf: [revisionSchema, { type: "null" }], description: "Use null for create-only; use the connections revision to replace an existing profile" } }, ["connection"]),
      execute({ connection, expectedRevision }, ctx = {}) {
        const profile = validateProfile(connection);
        if (profile.encryptedPassword) throw new Error("密码密文由本机生成，请勿在连接参数中提交");
        return serial(profile.id, async () => {
          if (sessions.isActive(profile.id)) throw new Error("请先断开连接再修改配置");
          await remote.assertProfileChange(profile);
          const saved = await store.save(profile, { expectedRevision, password: ctx.credentials?.password });
          return { connection: publicProfile(saved), revision: profileRevision(saved), hasSavedPassword: Boolean(saved.encryptedPassword) };
        });
      },
    },
    remove_connection: {
      description: "Delete a saved SSH profile using its expectedRevision from connections, then discard its runtime history. Disconnect the profile first so its active tunnels are not removed accidentally.",
      args: args({ connectionId: idSchema, expectedRevision: revisionSchema }),
      execute({ connectionId, expectedRevision }) {
        return serial(connectionId, async () => {
          if (sessions.isActive(connectionId)) throw new Error("请先断开连接再删除配置");
          await remote.assertIdle(connectionId);
          const result = await store.remove(connectionId, { expectedRevision });
          await sessions.forgetConnection(connectionId);
          try { await remote.forget(connectionId); }
          catch (cause) { throw new OperationError("REMOTE_CLEANUP_FAILED", "连接配置与 SSH 运行记录已删除，但远程管理缓存清理失败，请重新读取连接列表并检查本地记录文件", { cause }); }
          return result;
        });
      },
    },
    connect: {
      description: "Authenticate a saved SSH connection, verify its host key, then start its saved c2s/s2c forwards unless autoStartForwards is false. A failed preset rolls back by default; forwardFailurePolicy=continue preserves the connection for recoverable failures. No remote shell is executed.",
      args: args({ connectionId: idSchema }),
      execute({ connectionId }, ctx = {}) {
        identifier(connectionId);
        assertMutable();
        const controller = new AbortController();
        const pending = pendingConnects.get(connectionId) ?? new Set();
        pending.add(controller);
        pendingConnects.set(connectionId, pending);
        const signal = ctx.abort ? AbortSignal.any([ctx.abort, controller.signal]) : controller.signal;
        return serial(connectionId, async () => sessions.connect(await store.get(connectionId), { signal, credentials: ctx.credentials })).finally(() => {
          pending.delete(controller);
          if (!pending.size) pendingConnects.delete(connectionId);
        });
      },
    },
    disconnect: {
      description: "Disconnect one SSH session and stop all its forwards and active TCP channels. Keeps its saved profile.",
      args: args({ connectionId: idSchema }),
      async execute({ connectionId }) {
        identifier(connectionId);
        // Interrupt an in-flight connect immediately; do not wait on its queue.
        for (const controller of pendingConnects.get(connectionId) ?? []) controller.abort();
        return sessions.disconnect(connectionId);
      },
    },
    status: {
      description: "Show session state, observed public host fingerprint, forwards with recent targetConnection results, and transport errors. Only connected confirms authentication; listening and target TCP success do not guarantee target application health.",
      args: args({ connectionId: idSchema }, []),
      execute({ connectionId } = {}) {
        if (connectionId !== undefined) identifier(connectionId);
        return sessions.status(connectionId);
      },
    },
    forward_add: {
      description: "After SSH connects, add a TCP forward: c2s (-L) listens on this client and targets the server side; s2c (-R) listens on the server and targets this client. Runtime-only; use save_connection.forwards to persist it.",
      args: args({ connectionId: idSchema, forward: forwardSchema }),
      execute({ connectionId, forward }, ctx = {}) {
        return serial(connectionId, () => sessions.addForward(connectionId, forward, { signal: ctx.abort }));
      },
    },
    forward_remove: {
      description: "Stop one runtime TCP forward and close its active channels while leaving the SSH connection established.",
      args: args({ connectionId: idSchema, forwardId: idSchema }),
      execute({ connectionId, forwardId }) {
        identifier(forwardId);
        return serial(connectionId, () => sessions.removeForward(connectionId, forwardId));
      },
    },
    forward_save: {
      description: "Create or replace a saved c2s/s2c forward preset using the profile's expectedRevision from connections; return {forward, revision}. Stop this particular forward before editing it. Saving does not start the forward.",
      args: args({ connectionId: idSchema, forward: forwardSchema, expectedRevision: revisionSchema }),
      execute({ connectionId, forward, expectedRevision }) {
        const spec = validateForward(forward);
        return serial(connectionId, async () => {
          assertForwardEditable(connectionId);
          const profile = await store.get(connectionId);
          assertProfileRevision(profile, expectedRevision);
          if (sessions.status(connectionId).forwards.some((item) => item.id === spec.id)) {
            throw new Error("请先停止这条转发，再修改预设");
          }
          assertMutable();
          assertForwardEditable(connectionId);
          const forwards = profile.forwards.filter((item) => item.id !== spec.id);
          forwards.push(spec);
          const saved = await store.save({ ...profile, forwards }, { expectedRevision });
          sessions.forgetForward(connectionId, spec.id);
          return { forward: spec, revision: profileRevision(saved) };
        });
      },
    },
    forward_delete: {
      description: "Delete a saved forward preset using its profile's expectedRevision, then stop the running forward. Configuration failures leave tunnels running; a subsequent stop failure reports that the preset was already deleted. Leaves SSH connected unless remote cleanup is uncertain.",
      args: args({ connectionId: idSchema, forwardId: idSchema, expectedRevision: revisionSchema }),
      execute({ connectionId, forwardId, expectedRevision }) {
        identifier(forwardId);
        return serial(connectionId, async () => {
          assertForwardEditable(connectionId);
          const profile = await store.get(connectionId);
          assertProfileRevision(profile, expectedRevision);
          assertMutable();
          assertForwardEditable(connectionId);
          const running = sessions.status(connectionId).forwards.some((item) => item.id === forwardId);
          const saved = profile.forwards.some((item) => item.id === forwardId);
          if (!running && !saved) throw new Error(`转发 ${forwardId} 不存在`);
          if (saved) await store.save({ ...profile, forwards: profile.forwards.filter((item) => item.id !== forwardId) }, { expectedRevision });
          sessions.forgetForward(connectionId, forwardId);
          if (running) {
            try { await sessions.removeForward(connectionId, forwardId); }
            catch (cause) {
              throw new OperationError("FORWARD_STOP_FAILED", (saved ? "转发预设已删除，但停止运行中的转发失败：" : "停止临时转发失败：") + cause.message + "。请检查运行状态，必要时断开 SSH 连接以释放监听", { cause });
            }
          }
          return { id: forwardId, removed: true };
        });
      },
    },
  };
}

export async function createPlugin(input = {}, options) {
  const config = pluginOptions(input, options);
  const store = new ProfileStore(join(config.dataDirectory, "connections.json"));
  const sessions = new SessionManager(config);
  const remote = new RemoteManager({ store, sessions });
  const hooks = { tool: createTools(store, sessions, remote) };
  let web;
  if (config.webUI) {
    try {
      web = await startManagementServer({ tools: hooks.tool, port: config.uiPort });
      const file = fileURLToPath(new URL("../page/.runtime/endpoint.js", import.meta.url));
      const unpublish = await publishEndpoint(file, web.url);
      const close = web.close;
      web.close = async () => { unpublish(); await close(); };
    } catch (error) {
      await web?.close();
      throw error;
    }
  }
  const startup = new AbortController();
  const startupTask = store.list().then((profiles) => Promise.allSettled(profiles
    .filter((profile) => profile.autoConnect)
    .map((profile) => hooks.tool.connect.execute({ connectionId: profile.id }, { abort: startup.signal })))).catch(() => {});
  runtimes.set(hooks, { sessions, remote, web, startup, startupTask });
  return hooks;
}
