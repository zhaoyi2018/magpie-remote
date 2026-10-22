import { join } from "node:path";
import { identifier, pluginOptions, validateProfile } from "./config.mjs";
import { ProfileStore } from "./store.mjs";
import { SessionManager } from "./sessions.mjs";

const idSchema = { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$" };
const stringSchema = { type: "string", minLength: 1 };
const portSchema = { type: "integer", minimum: 1, maximum: 65535 };
const forwardSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "direction", "bindPort", "targetPort"],
  properties: {
    id: idSchema,
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
      description: "Authenticate a saved SSH connection, verify its host key, then start its saved c2s/s2c forwards. A failed saved forward rolls back the connection. No remote shell is executed.",
      args: args({ connectionId: idSchema }),
      execute({ connectionId }, ctx = {}) {
        identifier(connectionId);
        const controller = new AbortController();
        const pending = pendingConnects.get(connectionId) ?? new Set();
        pending.add(controller);
        pendingConnects.set(connectionId, pending);
        const signal = ctx.abort ? AbortSignal.any([ctx.abort, controller.signal]) : controller.signal;
        return serial(connectionId, async () => sessions.connect(await store.get(connectionId), { signal })).finally(() => {
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
  };
}

export async function createPlugin(input = {}, options) {
  const config = pluginOptions(input, options);
  const store = new ProfileStore(join(config.dataDirectory, "connections.json"));
  const sessions = new SessionManager(config);
  return { tool: createTools(store, sessions) };
}
