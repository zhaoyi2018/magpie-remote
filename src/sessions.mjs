import ssh2 from "ssh2";
import { createServer, connect as connectTCP } from "node:net";
import { readFile } from "node:fs/promises";
import { expandPath, validateForward, validateProfile } from "./config.mjs";
import { fingerprint, hostVerifier } from "./host-keys.mjs";

const { Client } = ssh2;

function aborted(signal) {
  if (signal?.aborted) throw new Error("操作已取消");
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

export class SessionManager {
  #sessions = new Map();

  constructor({ connectTimeoutMs = 15000, forwardTimeoutMs = 10000, env = process.env } = {}) {
    this.connectTimeoutMs = connectTimeoutMs;
    this.forwardTimeoutMs = forwardTimeoutMs;
    this.env = env;
  }

  status(id) {
    const views = [...this.#sessions.values()].map((session) => this.#view(session));
    return id === undefined ? views : views.find((item) => item.id === id) ?? { id, state: "disconnected", forwards: [] };
  }

  isActive(id) {
    return ["connecting", "connected"].includes(this.#sessions.get(id)?.state);
  }

  async connect(value, { signal, credentials } = {}) {
    aborted(signal);
    const profile = validateProfile(value);
    const previous = this.#sessions.get(profile.id);
    if (previous?.state === "connected") return this.#view(previous);
    if (previous?.state === "connecting") return previous.pending;
    const session = {
      id: profile.id, state: "connecting", client: new Client(), forwards: new Map(),
      host: profile.host, port: profile.port, username: profile.username,
    };
    this.#sessions.set(profile.id, session);
    session.pending = this.#open(session, profile, signal, credentials);
    return session.pending;
  }

  async #open(session, profile, signal, credentials = {}) {
    const cancel = () => this.#fail(session, new Error("连接已取消"));
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const verify = await hostVerifier(profile);
      const config = {
        host: profile.host, port: profile.port, username: profile.username,
        readyTimeout: this.connectTimeoutMs, keepaliveInterval: 15000, keepaliveCountMax: 3,
        hostVerifier: (key) => {
          session.hostFingerprint = fingerprint(key);
          session.hostRejected = !verify(key);
          return !session.hostRejected;
        },
      };
      if (profile.identityFile) config.privateKey = await readFile(expandPath(profile.identityFile));
      for (const [field, variable] of [["password", profile.passwordEnv], ["passphrase", profile.passphraseEnv]]) {
        if (credentials[field]) { config[field] = credentials[field]; continue; }
        if (!variable) continue;
        if (!this.env[variable]) throw new Error(`环境变量 ${variable} 未设置`);
        config[field] = this.env[variable];
      }
      config.agent = profile.agent ?? this.env.SSH_AUTH_SOCK
        ?? (profile.authMethod === "agent" && process.platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : undefined);
      if (profile.authMethod) {
        const methods = profile.authMethod === "agent" ? ["agent", "publickey", "password"]
          : profile.authMethod === "key" ? ["publickey", "password", "agent"] : ["password", "publickey", "agent"];
        config.authHandler = ["none", ...methods.filter((method) => method === "agent" ? config.agent : method === "publickey" ? config.privateKey : config.password)];
      }
      if (!config.agent && !config.privateKey && !config.password) {
        throw new Error("请配置 identityFile、agent 或 passwordEnv 以进行 SSH 认证");
      }
      aborted(signal);
      if (session.state !== "connecting") throw new Error("连接已停止");
      session.client.on("tcp connection", (info, accept, reject) => this.#incoming(session, info, accept, reject));
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.#fail(session, new Error("SSH 连接超时"));
        }, this.connectTimeoutMs);
        const finish = (error) => {
          clearTimeout(timeout);
          session.rejectConnect = undefined;
          if (error) reject(error);
          else resolve();
        };
        session.rejectConnect = finish;
        session.client.once("ready", () => {
          if (session.state !== "connecting") return;
          session.state = "connected";
          session.connectedAt = new Date().toISOString();
          finish();
        });
        session.client.on("error", (error) => {
          if (session.state === "disconnected") return;
          // ssh2 emits agent errors before trying the next configured method.
          if (error.level === "agent" && session.state === "connecting" && (config.privateKey || config.password)) return;
          const reason = session.hostRejected
            ? new Error("SSH 主机公钥未被信任或已变化；请核对 hostFingerprint / known_hosts")
            : error;
          finish(reason);
          this.#fail(session, reason);
        });
        session.client.once("close", () => {
          if (session.state === "connecting") finish(new Error("SSH 认证完成前连接已关闭"));
          if (session.state !== "failed") session.state = "disconnected";
          void this.#releaseAll(session);
        });
        session.client.connect(config);
      });
      if (profile.autoStartForwards !== false) {
        for (const forward of profile.forwards) await this.addForward(profile.id, forward, { signal });
      }
      aborted(signal);
      if (session.state !== "connected") throw new Error(session.lastError ?? "SSH 连接已关闭");
      return this.#view(session);
    } catch (error) {
      if (session.state !== "disconnected") this.#fail(session, error);
      await this.#releaseAll(session);
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  async addForward(id, value, { signal } = {}) {
    aborted(signal);
    const spec = validateForward(value);
    const session = this.#sessions.get(id);
    if (session?.state !== "connected") throw new Error("请先成功建立 SSH 连接，再创建转发");
    if (session.forwards.has(spec.id)) throw new Error(`转发 ${spec.id} 已存在`);
    if (spec.bindPort !== 0 && [...session.forwards.values()].some((item) => (
      item.direction === spec.direction && item.bindHost === spec.bindHost && item.bindPort === spec.bindPort
    ))) throw new Error("该监听地址和端口已被另一条转发使用");
    const forward = { ...spec, state: "starting", resources: new Set() };
    session.forwards.set(forward.id, forward);
    const cancel = () => this.#fail(session, new Error("转发创建已取消，SSH 连接已关闭"));
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await this.#deadline(session, new Promise((resolve, reject) => {
        forward.rejectSetup = reject;
        if (forward.direction === "c2s") {
          forward.server = createServer({ allowHalfOpen: true }, (socket) => this.#outgoing(session, forward, socket));
          forward.server.on("error", (error) => {
            forward.lastError = error.code ?? error.message;
            if (forward.state === "starting") reject(error);
            else forward.state = "failed";
          });
          forward.server.listen({ host: forward.bindHost, port: forward.bindPort, exclusive: true }, () => {
            forward.bindPort = forward.server.address().port;
            resolve();
          });
        } else {
          session.client.forwardIn(forward.bindHost, forward.bindPort, (error, port) => {
            if (error) reject(error);
            else {
              forward.bindPort = port ?? forward.bindPort;
              resolve();
            }
          });
        }
      }));
      aborted(signal);
      if (session.state !== "connected") throw new Error("SSH 连接已关闭");
      forward.state = "listening";
      return this.#forwardView(forward);
    } catch (error) {
      session.forwards.delete(forward.id);
      await this.#releaseLocal(forward);
      // A remote allocation whose reply was lost must not outlive its session.
      if (forward.direction === "s2c") this.#fail(session, error);
      throw error;
    } finally {
      forward.rejectSetup = undefined;
      signal?.removeEventListener("abort", cancel);
    }
  }

  async removeForward(id, forwardId) {
    const session = this.#sessions.get(id);
    const forward = session?.forwards.get(forwardId);
    if (!forward) throw new Error(`转发 ${forwardId} 不存在`);
    if (forward.state === "starting") throw new Error("转发正在创建，请等待完成或断开整个连接");
    forward.state = "stopping";
    try {
      if (forward.direction === "s2c" && session.state === "connected") {
        await this.#deadline(session, new Promise((resolve, reject) => {
          session.client.unforwardIn(forward.bindHost, forward.bindPort, (error) => error ? reject(error) : resolve());
        }));
      }
    } catch (error) {
      this.#fail(session, error);
      throw error;
    } finally {
      session.forwards.delete(forward.id);
      await this.#releaseLocal(forward);
    }
    return { id: forwardId, stopped: true };
  }

  async disconnect(id) {
    const session = this.#sessions.get(id);
    if (!session) return { id, state: "disconnected", forwards: [] };
    session.state = "disconnected";
    session.rejectConnect?.(new Error("连接已断开"));
    session.client.destroy();
    await this.#releaseAll(session);
    return this.#view(session);
  }

  async close() {
    await Promise.all([...this.#sessions.keys()].map((id) => this.disconnect(id)));
  }

  #deadline(session, promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("转发操作超时，SSH 连接已关闭以释放监听");
        this.#fail(session, error);
        reject(error);
      }, this.forwardTimeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  #track(forward, resource) {
    forward.resources.add(resource);
    resource.once("close", () => forward.resources.delete(resource));
    resource.on("error", (error) => { forward.lastError = error.code ?? error.message; });
    return resource;
  }

  #bridge(forward, channel, socket) {
    this.#track(forward, channel);
    const stop = () => { channel.destroy(); socket.destroy(); };
    channel.on("error", stop);
    socket.on("error", stop);
    channel.once("close", () => socket.end());
    socket.once("close", () => channel.destroy());
    channel.pipe(socket).pipe(channel);
  }

  #outgoing(session, forward, socket) {
    if (session.state !== "connected" || forward.state !== "listening") return socket.destroy();
    this.#track(forward, socket);
    const timer = setTimeout(() => socket.destroy(), this.forwardTimeoutMs);
    socket.once("close", () => clearTimeout(timer));
    session.client.forwardOut(socket.remoteAddress ?? "127.0.0.1", socket.remotePort ?? 0,
      forward.targetHost, forward.targetPort, (error, channel) => {
        clearTimeout(timer);
        if (error) {
          forward.lastError = error.message;
          socket.destroy();
          return;
        }
        if (socket.destroyed || session.state !== "connected" || forward.state !== "listening") {
          channel.on("error", () => {});
          channel.destroy();
          socket.destroy();
          return;
        }
        this.#bridge(forward, channel, socket);
      });
  }

  #incoming(session, info, accept, reject) {
    const forward = [...session.forwards.values()].find((item) => (
      item.direction === "s2c" && item.state === "listening" && item.bindPort === info.destPort
      && (item.bindHost === info.destIP || ["0.0.0.0", "::", "*"].includes(item.bindHost))
    ));
    if (!forward || session.state !== "connected") return reject();
    const socket = this.#track(forward, connectTCP({ host: forward.targetHost, port: forward.targetPort, allowHalfOpen: true }));
    let answered = false;
    const deny = () => {
      if (!answered) {
        answered = true;
        try { reject(); } catch { /* The SSH connection may already be closed. */ }
      }
      socket.destroy();
    };
    const timer = setTimeout(deny, this.forwardTimeoutMs);
    socket.once("error", deny);
    socket.once("close", () => { clearTimeout(timer); deny(); });
    socket.once("connect", () => {
      clearTimeout(timer);
      if (answered || session.state !== "connected" || forward.state !== "listening") return deny();
      answered = true;
      const channel = accept();
      if (channel) this.#bridge(forward, channel, socket);
      else socket.destroy();
    });
  }

  #fail(session, error) {
    if (session.state === "disconnected") return;
    session.lastError = String(error.message ?? error).slice(0, 300);
    session.state = "failed";
    session.rejectConnect?.(error);
    session.client.destroy();
    void this.#releaseAll(session);
  }

  async #releaseAll(session) {
    const forwards = [...session.forwards.values()];
    session.forwards.clear();
    const error = new Error("SSH 连接已关闭");
    for (const forward of forwards) forward.rejectSetup?.(error);
    await Promise.all(forwards.map((forward) => this.#releaseLocal(forward)));
  }

  async #releaseLocal(forward) {
    for (const resource of forward.resources) resource.destroy();
    forward.resources.clear();
    await closeServer(forward.server);
  }

  #forwardView(forward) {
    const { id, direction, bindHost, bindPort, targetHost, targetPort, state, lastError } = forward;
    return { id, direction, bindHost, bindPort, targetHost, targetPort, state, ...(lastError && { lastError }) };
  }

  #view(session) {
    const { id, host, port, username, state, connectedAt, hostFingerprint, lastError } = session;
    return {
      id, host, port, username, state, connectedAt, hostFingerprint,
      ...(lastError && { lastError }),
      forwards: [...session.forwards.values()].map((forward) => this.#forwardView(forward)),
    };
  }
}
