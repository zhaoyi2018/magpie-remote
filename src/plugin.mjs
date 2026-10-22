import { join } from "node:path";
import { identifier, pluginOptions, validateForward, validateProfile } from "./config.mjs";
import { ProfileStore } from "./store.mjs";
import { SessionManager } from "./sessions.mjs";
import { startManagementServer, publishEndpoint } from "./web-server.mjs";
import { fileURLToPath } from "node:url";
import { readSSHConfig } from "./ssh-config.mjs";

const runtimes = new WeakMap();
export async function closePlugin(hooks) {
  const runtime = runtimes.get(hooks);
  if (runtime) {
    runtime.startup.abort();
    await runtime.startupTask;
    await runtime.web?.close();
    await runtime.sessions.close();
    runtimes.delete(hooks);
  }
}

const idSchema = { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$" };
const stringSchema = { type: "string", minLength: 1 };
const portSchema = { type: "integer", minimum: 1, maximum: 65535 };
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
    authMethod: { type: "string", enum: ["agent", "key", "environment"], description: "Preferred authentication method; other configured credentials remain available as fallbacks" },
    autoStartForwards: { type: "boolean", default: true, description: "Start saved forward presets after successful authentication" },
    autoConnect: { type: "boolean", default: false, description: "Try connecting once when the plugin host starts; no session credentials are persisted" },
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

export function createTools(store, sessions) {
  // Serialize configuration and session mutations for each profile, while allowing
  // independent connections to proceed in parallel in Magpie's shared host.
  const operations = new Map();
  const pendingConnects = new Map();
  const serial = (id, action) => {
    identifier(id);
    const operation = (operations.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    operations.set(id, operation);
    void operation.finally(() => {
      if (operations.get(id) === operation) operations.delete(id);
    }).catch(() => {});
    return operation;
  };
  return {
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
        return store.importProfiles(profiles);
      },
    },
    connections: {
      description: "List saved SSH connection profiles and their current session states. Does not connect.",
      args: args({}),
      async execute() {
        return (await store.list()).map((connection) => ({ connection, session: sessions.status(connection.id) }));
      },
    },
    save_connection: {
      description: "Create or replace an SSH profile. Stores paths and environment-variable names, never passwords or key contents. Disconnect before updating an active profile.",
      args: args({ connection: profileSchema }),
      execute({ connection }) {
        const profile = validateProfile(connection);
        return serial(profile.id, () => {
          if (sessions.isActive(profile.id)) throw new Error("请先断开连接再修改配置");
          return store.save(profile);
        });
      },
    },
    remove_connection: {
      description: "Delete a saved SSH profile. Disconnect the profile first so its active tunnels are not removed accidentally.",
      args: args({ connectionId: idSchema }),
      execute({ connectionId }) {
        return serial(connectionId, () => {
          if (sessions.isActive(connectionId)) throw new Error("请先断开连接再删除配置");
          return store.remove(connectionId);
        });
      },
    },
    connect: {
      description: "Authenticate a saved SSH connection, verify its host key, then start its saved c2s/s2c forwards unless autoStartForwards is false. A failed saved forward rolls back the connection. No remote shell is executed.",
      args: args({ connectionId: idSchema }),
      execute({ connectionId }, ctx = {}) {
        identifier(connectionId);
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
      description: "Show session state, observed public host fingerprint, forwards and recent transport errors. Only connected confirms authentication; listening does not guarantee target application health.",
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
      description: "Create or replace a saved c2s/s2c forward preset without disconnecting SSH. Stop this particular forward before editing it. Saving does not start the forward.",
      args: args({ connectionId: idSchema, forward: forwardSchema }),
      execute({ connectionId, forward }) {
        const spec = validateForward(forward);
        return serial(connectionId, async () => {
          if (sessions.status(connectionId).forwards.some((item) => item.id === spec.id)) {
            throw new Error("请先停止这条转发，再修改预设");
          }
          const profile = await store.get(connectionId);
          const forwards = profile.forwards.filter((item) => item.id !== spec.id);
          forwards.push(spec);
          await store.save({ ...profile, forwards });
          return spec;
        });
      },
    },
    forward_delete: {
      description: "Stop one forward if it is running, and remove its saved preset. Leaves the SSH connection established.",
      args: args({ connectionId: idSchema, forwardId: idSchema }),
      execute({ connectionId, forwardId }) {
        identifier(forwardId);
        return serial(connectionId, async () => {
          const profile = await store.get(connectionId);
          const running = sessions.status(connectionId).forwards.some((item) => item.id === forwardId);
          const saved = profile.forwards.some((item) => item.id === forwardId);
          if (!running && !saved) throw new Error(`转发 ${forwardId} 不存在`);
          if (running) await sessions.removeForward(connectionId, forwardId);
          if (saved) await store.save({ ...profile, forwards: profile.forwards.filter((item) => item.id !== forwardId) });
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
  const hooks = { tool: createTools(store, sessions) };
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
  runtimes.set(hooks, { sessions, web, startup, startupTask });
  return hooks;
}
