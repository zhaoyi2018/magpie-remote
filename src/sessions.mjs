import ssh2 from "ssh2";
import { createServer, connect as connectTCP } from "node:net";
import { validateForward, validateProfile } from "./config.mjs";
import { fingerprint, hostVerifier } from "./host-keys.mjs";
import { prepareAuthentication, credentialRequest } from "./authentication.mjs";
import { OperationError, errorDetails, sshFailure } from "./errors.mjs";
import { executeRemote } from "./remote-exec.mjs";

const { Client } = ssh2;

function aborted(signal) {
  if (signal?.aborted) throw new OperationError("OPERATION_CANCELLED", "操作已取消");
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

export class SessionManager {
  #sessions = new Map();
  #intents = new Map();
  #closed = false;

  constructor({ connectTimeoutMs = 15000, forwardTimeoutMs = 10000, env = process.env,
    reconnectDelayMs = 1000, reconnectMaxDelayMs = 30000, reconnectStableMs = 30000, random = Math.random,
    keepaliveIntervalMs = 15000, keepaliveCountMax = 3, connectTarget = connectTCP, passwordVault } = {}) {
    this.connectTimeoutMs = connectTimeoutMs;
    this.forwardTimeoutMs = forwardTimeoutMs;
    this.env = env;
    this.reconnectDelayMs = reconnectDelayMs;
    this.reconnectMaxDelayMs = reconnectMaxDelayMs;
    this.reconnectStableMs = reconnectStableMs;
    this.random = random;
    this.keepaliveIntervalMs = keepaliveIntervalMs;
    this.keepaliveCountMax = keepaliveCountMax;
    this.connectTarget = connectTarget;
    this.passwordVault = passwordVault;
  }

  status(id) {
    const views = [...this.#sessions.values()].map((session) => this.#view(session));
    return id === undefined ? views : views.find((item) => item.id === id) ?? { id, state: "disconnected", forwards: [] };
  }

  isActive(id) {
    return ["connecting", "connected"].includes(this.#sessions.get(id)?.state)
      || ["waiting", "connecting"].includes(this.#intents.get(id)?.phase);
  }

  async connect(value, { signal, credentials } = {}) {
    aborted(signal);
    if (this.#closed) throw new OperationError("OPERATION_CANCELLED", "插件已关闭");
    const profile = validateProfile(value);
    const previous = this.#sessions.get(profile.id);
    if (previous?.state === "connected") return this.#view(previous);
    if (previous?.state === "connecting") return previous.pending;
    const continuing = this.#intents.get(profile.id);
    const wantedForwards = continuing?.enabled && continuing.wanted && JSON.stringify(continuing.profile) === JSON.stringify(profile)
      ? continuing.forwards : new Map((profile.autoStartForwards === false ? [] : profile.forwards).map((forward) => [forward.id, forward]));
    this.#stopIntent(profile.id);
    const intent = { profile, enabled: profile.autoReconnect === true, wanted: true, attempts: 0, phase: "connecting",
      forwards: new Map(wantedForwards) };
    this.#intents.set(profile.id, intent);
    return this.#start(intent, signal, credentials);
  }

  #start(intent, signal, credentials) {
    const profile = intent.profile;
    const previous = this.#sessions.get(profile.id);
    intent.controller = new AbortController();
    intent.phase = "connecting";
    intent.nextRetryAt = undefined;
    const combined = signal ? AbortSignal.any([signal, intent.controller.signal]) : intent.controller.signal;
    const session = {
      id: profile.id, state: "connecting", client: new Client(), forwards: new Map(), forwardErrors: new Map(),
      host: profile.host, port: profile.port, username: profile.username,
      logs: previous?.logs ?? [],
      lastConnectedAt: previous?.connectedAt ?? previous?.lastConnectedAt,
      intent, established: false,
    };
    this.#sessions.set(profile.id, session);
    this.#log(session, "info", "正在建立 SSH 连接 " + profile.username + "@" + profile.host + ":" + profile.port);
    session.pending = (async () => {
      await previous?.cleanup;
      aborted(combined);
      return this.#open(session, profile, combined, credentials);
    })().then(() => {
      aborted(combined);
      if (session.state !== "connected") throw new OperationError("SSH_DISCONNECTED", "SSH 连接已中断");
      session.established = true;
      intent.phase = "idle";
      intent.reason = undefined;
      clearTimeout(intent.stableTimer);
      intent.stableTimer = setTimeout(() => { intent.attempts = 0; }, this.reconnectStableMs);
      intent.stableTimer.unref?.();
      return this.#view(session);
    }).catch(async (error) => {
      if (!["disconnected", "failed"].includes(session.state)) this.#fail(session, error);
      await this.#releaseAll(session);
      this.#scheduleReconnect(session, error);
      throw error;
    });
    return session.pending;
  }

  async #open(session, profile, signal, credentials = {}) {
    const cancel = () => this.#fail(session, new OperationError("OPERATION_CANCELLED", "连接已取消并停止"));
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const verify = await hostVerifier(profile);
      const config = {
        host: profile.host, port: profile.port, username: profile.username,
        readyTimeout: this.connectTimeoutMs, keepaliveInterval: this.keepaliveIntervalMs, keepaliveCountMax: this.keepaliveCountMax,
        hostVerifier: (key) => {
          session.hostFingerprint = fingerprint(key);
          session.hostRejected = !verify(key);
          return !session.hostRejected;
        },
      };
      const authentication = await prepareAuthentication(profile, this.env, credentials, this.passwordVault);
      Object.assign(config, authentication.config);
      for (const issue of authentication.issues) this.#log(session, "warn", issue.message + "；将尝试其他可用认证方式");
      aborted(signal);
      if (session.state !== "connecting") throw new Error("连接已停止");
      session.client.on("tcp connection", (info, accept, reject) => this.#incoming(session, info, accept, reject));
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.#fail(session, new OperationError("SSH_TIMEOUT", "SSH 连接超时，请检查服务器地址和网络"));
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
          session.lastConnectedAt = session.connectedAt;
          this.#log(session, "info", "SSH 认证成功，连接已建立");
          finish();
        });
        session.client.on("error", (error) => {
          if (session.state === "disconnected") return;
          // ssh2 emits agent errors before trying the next configured method.
          if (error.level === "agent" && session.state === "connecting" && (config.privateKey || config.password)) return;
          const reason = session.hostRejected
            ? new OperationError("HOST_KEY_REJECTED", "SSH 主机公钥未被信任或已变化；请核对 hostFingerprint / known_hosts")
            : ["client-authentication", "agent"].includes(error.level)
              ? credentialRequest(authentication.issues) ?? sshFailure(error)
              : sshFailure(error);
          finish(reason);
          this.#fail(session, reason);
        });
        session.client.once("close", () => {
          if (["failed", "disconnected"].includes(session.state)) return;
          const reason = new OperationError("SSH_DISCONNECTED", "SSH 连接已关闭，正在释放全部转发");
          finish(reason);
          this.#fail(session, reason, "disconnected");
        });
        session.client.connect(config);
      });
      if (session.intent.forwards.size) {
        for (const forward of [...session.intent.forwards.values()]) {
          try { await this.addForward(profile.id, forward, { signal, internal: true }); }
          catch (error) {
            if (profile.forwardFailurePolicy !== "continue" || session.state !== "connected" || signal?.aborted) throw error;
            session.forwardErrors.set(forward.id, { id: forward.id, message: error.message });
            this.#log(session, "warn", "预设「" + (forward.name ?? forward.id) + "」未启动，保留 SSH 连接并继续启动其他预设");
          }
        }
      }
      aborted(signal);
      if (session.state !== "connected") throw new Error(session.lastError ?? "SSH 连接已关闭");
      return this.#view(session);
    } catch (error) {
      if (session.state !== "disconnected") this.#fail(session, error);
      await this.#releaseAll(session);
      throw session.failure ?? error;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  execute(id, command, options) {
    const session = this.#sessions.get(id);
    if (session?.state !== "connected" || session.intent.phase === "connecting") {
      throw new OperationError("REMOTE_NOT_CONNECTED", "请先建立 SSH 连接，再管理远程 Magpie");
    }
    return executeRemote(session.client, command, options);
  }

  async addForward(id, value, { signal, internal = false } = {}) {
    aborted(signal);
    const spec = validateForward(value);
    const session = this.#sessions.get(id);
    if (!internal && session?.intent.phase === "connecting") throw new OperationError("SESSION_BUSY", "连接恢复中，请稍后再操作转发");
    if (session?.state !== "connected") throw new Error("请先成功建立 SSH 连接，再创建转发");
    if (session.forwards.has(spec.id)) throw new Error(`转发 ${spec.id} 已存在`);
    if (spec.bindPort !== 0 && [...session.forwards.values()].some((item) => (
      item.direction === spec.direction && item.bindHost === spec.bindHost && item.bindPort === spec.bindPort
    ))) throw new Error("该监听地址和端口已被另一条转发使用");
    const forward = { ...spec, state: "starting", resources: new Set(), targetConnection: { state: "unknown" } };
    let remoteRejected = false;
    session.forwards.set(forward.id, forward);
    const cancel = () => this.#fail(session, new OperationError("OPERATION_CANCELLED", "转发创建已取消，SSH 连接已关闭"));
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await this.#deadline(session, new Promise((resolve, reject) => {
        forward.rejectSetup = reject;
        if (forward.direction === "c2s") {
          forward.server = createServer({ allowHalfOpen: true }, (socket) => this.#outgoing(session, forward, socket));
          forward.server.on("error", (error) => {
            forward.lastError = error.code ?? error.message;
            if (forward.state === "starting") reject(new OperationError("FORWARD_BIND_FAILED", "无法建立本地监听：" + error.message, { cause: error }));
            else forward.state = "failed";
          });
          forward.server.listen({ host: forward.bindHost, port: forward.bindPort, exclusive: true }, () => {
            forward.bindPort = forward.server.address().port;
            resolve();
          });
        } else {
          session.client.forwardIn(forward.bindHost, forward.bindPort, (error, port) => {
            if (error) {
              // ssh2 1.17 uses this exact response for SSH REQUEST_FAILURE.
              // Transport failures (including a lost reply) remain fatal.
              remoteRejected = error.message === `Unable to bind to ${forward.bindHost}:${forward.bindPort}`;
              reject(remoteRejected ? new OperationError("FORWARD_REJECTED", "服务器拒绝此转发，请检查远端端口占用和 SSH 转发权限", { cause: error }) : error);
            }
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
      session.intent.forwards.set(spec.id, spec);
      session.forwardErrors.delete(forward.id);
      this.#log(session, "info", "转发「" + (forward.name ?? forward.id) + "」已启动（" + forward.direction + "）：" + forward.bindHost + ":" + forward.bindPort + " → " + forward.targetHost + ":" + forward.targetPort);
      return this.#forwardView(forward);
    } catch (error) {
      this.#log(session, "error", "转发「" + (forward.name ?? forward.id) + "」启动失败：" + error.message);
      session.forwards.delete(forward.id);
      session.forwardErrors.set(forward.id, { id: forward.id, message: error.message });
      await this.#releaseLocal(forward);
      // A remote allocation whose reply was lost must not outlive its session.
      if (forward.direction === "s2c" && !remoteRejected) this.#fail(session, error);
      throw session.failure ?? error;
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
    session.intent.forwards.delete(forwardId);
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
    this.#log(session, "info", "转发「" + (forward.name ?? forward.id) + "」已停止，监听已释放");
    return { id: forwardId, stopped: true };
  }

  async disconnect(id) {
    this.#stopIntent(id);
    const session = this.#sessions.get(id);
    if (!session) return { id, state: "disconnected", forwards: [] };
    if (session.state === "disconnected") { await this.#releaseAll(session); return this.#view(session); }
    session.state = "disconnected";
    session.rejectConnect?.(new Error("连接已断开"));
    session.client.destroy();
    await this.#releaseAll(session);
    this.#log(session, "info", "SSH 连接已断开，全部转发已停止");
    return this.#view(session);
  }

  async close() {
    this.#closed = true;
    await this.disconnectAll();
  }

  async disconnectAll() {
    await Promise.all([...this.#sessions.keys()].map((id) => this.disconnect(id)));
  }

  async forgetConnection(id) {
    if (this.isActive(id)) throw new OperationError("SESSION_BUSY", "请先断开连接，再清理运行记录");
    const session = this.#sessions.get(id);
    this.#stopIntent(id);
    if (session) {
      session.client.destroy();
      await this.#releaseAll(session);
      if (this.#sessions.get(id) === session) this.#sessions.delete(id);
    }
  }

  forgetForward(id, forwardId) {
    this.#intents.get(id)?.forwards.delete(forwardId);
    this.#sessions.get(id)?.forwardErrors.delete(forwardId);
  }

  #stopIntent(id) {
    const intent = this.#intents.get(id);
    if (!intent) return;
    intent.wanted = false;
    intent.phase = "stopped";
    intent.nextRetryAt = undefined;
    clearTimeout(intent.timer);
    clearTimeout(intent.stableTimer);
    intent.timer = undefined;
    intent.controller?.abort();
    this.#intents.delete(id);
  }

  #scheduleReconnect(session, error) {
    const intent = session.intent;
    if (this.#closed || !intent.wanted || this.#intents.get(session.id) !== intent || this.#sessions.get(session.id) !== session) return;
    clearTimeout(intent.stableTimer);
    if (intent.timer) return;
    intent.reason = error.message;
    if (!intent.enabled || error.retryable !== true) {
      intent.phase = intent.enabled ? "paused" : "idle";
      if (intent.enabled) this.#log(session, "warn", "自动重连已暂停：" + error.message);
      return;
    }
    const base = Math.min(this.reconnectMaxDelayMs, this.reconnectDelayMs * 2 ** Math.min(intent.attempts, 16));
    const delay = Math.min(this.reconnectMaxDelayMs, Math.max(1, Math.round(base * (0.8 + this.random() * 0.4))));
    intent.attempts++;
    intent.phase = "waiting";
    intent.nextRetryAt = new Date(Date.now() + delay).toISOString();
    this.#log(session, "warn", `网络暂不可用，${Math.ceil(delay / 1000)} 秒后进行第 ${intent.attempts} 次自动重连`);
    intent.timer = setTimeout(() => {
      intent.timer = undefined;
      if (this.#closed || !intent.wanted || this.#intents.get(session.id) !== intent) return;
      void this.#start(intent).catch(() => {});
    }, delay);
    intent.timer.unref?.();
  }

  #deadline(session, promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new OperationError("FORWARD_TIMEOUT", "转发操作超时，SSH 连接已关闭以释放监听");
        // Preserve the timeout as the caller's error before cleanup rejects setup.
        reject(error);
        this.#fail(session, error);
      }, this.forwardTimeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  #track(forward, resource) {
    forward.resources.add(resource);
    resource.once("close", () => forward.resources.delete(resource));
    resource.on("error", () => {});
    return resource;
  }

  #beginTarget(forward) {
    const attempt = { state: "connecting" };
    forward.targetAttempt = attempt;
    forward.targetConnection = { ...forward.targetConnection, state: "connecting", lastAttemptAt: new Date().toISOString() };
    return attempt;
  }

  #targetResult(session, forward, attempt, error) {
    if (attempt.state === "failed" || (!error && attempt.state !== "connecting")) return;
    attempt.state = error ? "failed" : "succeeded";
    if (session.state !== "connected" || forward.state !== "listening") return;
    const current = forward.targetAttempt === attempt;
    if (error) {
      const failure = error instanceof OperationError ? error
        : new OperationError("FORWARD_TARGET_FAILED", "目标连接失败：" + error.message, { cause: error });
      if (current) {
        forward.lastError = failure.message;
        forward.targetConnection = { ...forward.targetConnection, state: "failed", lastFailureAt: new Date().toISOString(), error: errorDetails(failure) };
      }
      this.#log(session, "error", "转发「" + (forward.name ?? forward.id) + "」" + failure.message);
    } else if (current) {
      const recovered = Boolean(forward.lastError);
      delete forward.lastError;
      forward.targetConnection = { ...forward.targetConnection, state: "succeeded", lastSuccessAt: new Date().toISOString() };
      delete forward.targetConnection.error;
      if (recovered) this.#log(session, "info", "转发「" + (forward.name ?? forward.id) + "」目标连接已恢复");
    }
  }

  #bridge(session, forward, channel, socket, attempt) {
    this.#track(forward, channel);
    const stop = (error) => {
      this.#targetResult(session, forward, attempt, new OperationError("FORWARD_STREAM_FAILED", "目标连接传输失败：" + error.message, { cause: error }));
      channel.destroy(); socket.destroy();
    };
    channel.on("error", stop);
    socket.on("error", stop);
    channel.once("close", () => socket.end());
    socket.once("close", () => channel.destroy());
    channel.pipe(socket).pipe(channel);
  }

  #outgoing(session, forward, socket) {
    if (session.state !== "connected" || forward.state !== "listening") return socket.destroy();
    this.#track(forward, socket);
    const attempt = this.#beginTarget(forward);
    const timer = setTimeout(() => {
      this.#targetResult(session, forward, attempt, new OperationError("FORWARD_TARGET_TIMEOUT", "目标连接超时：服务器未及时建立转发通道"));
      socket.destroy();
    }, this.forwardTimeoutMs);
    socket.once("error", (error) => {
      if (attempt.state === "connecting") this.#targetResult(session, forward, attempt, error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      if (attempt.state === "connecting") this.#targetResult(session, forward, attempt, new OperationError("FORWARD_TARGET_CANCELLED", "目标连接建立前，请求已关闭"));
    });
    session.client.forwardOut(socket.remoteAddress ?? "127.0.0.1", socket.remotePort ?? 0,
      forward.targetHost, forward.targetPort, (error, channel) => {
        clearTimeout(timer);
        if (error) {
          this.#targetResult(session, forward, attempt, error);
          socket.destroy();
          return;
        }
        if (socket.destroyed || session.state !== "connected" || forward.state !== "listening") {
          channel.on("error", () => {});
          channel.destroy();
          socket.destroy();
          return;
        }
        this.#targetResult(session, forward, attempt);
        this.#bridge(session, forward, channel, socket, attempt);
      });
  }

  #incoming(session, info, accept, reject) {
    const forward = [...session.forwards.values()].find((item) => (
      item.direction === "s2c" && item.state === "listening" && item.bindPort === info.destPort
      && (item.bindHost === info.destIP || ["0.0.0.0", "::", "*"].includes(item.bindHost))
    ));
    if (!forward || session.state !== "connected") return reject();
    const attempt = this.#beginTarget(forward);
    let socket;
    try { socket = this.#track(forward, this.connectTarget({ host: forward.targetHost, port: forward.targetPort, allowHalfOpen: true })); }
    catch (error) { this.#targetResult(session, forward, attempt, error); return reject(); }
    let answered = false;
    const deny = () => {
      if (!answered) {
        answered = true;
        try { reject(); } catch { /* The SSH connection may already be closed. */ }
      }
      socket.destroy();
    };
    const timer = setTimeout(() => {
      this.#targetResult(session, forward, attempt, new OperationError("FORWARD_TARGET_TIMEOUT", "目标连接超时：本机目标未及时接受 TCP 连接"));
      deny();
    }, this.forwardTimeoutMs);
    socket.once("error", (error) => {
      if (attempt.state === "connecting") this.#targetResult(session, forward, attempt, error);
      deny();
    });
    socket.once("close", () => {
      clearTimeout(timer);
      if (attempt.state === "connecting") this.#targetResult(session, forward, attempt, new OperationError("FORWARD_TARGET_CANCELLED", "目标连接建立前，请求已关闭"));
      deny();
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      if (answered || session.state !== "connected" || forward.state !== "listening") return deny();
      answered = true;
      try {
        const channel = accept();
        if (channel) {
          this.#targetResult(session, forward, attempt);
          this.#bridge(session, forward, channel, socket, attempt);
        } else {
          this.#targetResult(session, forward, attempt, new OperationError("FORWARD_TARGET_CANCELLED", "目标连接建立前，远程请求已关闭"));
          socket.destroy();
        }
      } catch (error) { this.#targetResult(session, forward, attempt, error); socket.destroy(); }
    });
  }

  #fail(session, error, state = "failed") {
    if (["disconnected", "failed"].includes(session.state)) return;
    session.failure = error;
    session.error = errorDetails(error);
    session.lastError = String(error.message ?? error).slice(0, 300);
    if (session.state !== "failed") this.#log(session, "error", "SSH 连接失败：" + session.lastError);
    session.state = state;
    session.rejectConnect?.(error);
    session.client.destroy();
    const cleanup = this.#releaseAll(session);
    if (session.established) void cleanup.then(() => this.#scheduleReconnect(session, error));
  }

  #releaseAll(session) {
    if (session.cleanup) return session.cleanup;
    const forwards = [...session.forwards.values()];
    session.forwards.clear();
    const error = new Error("SSH 连接已关闭");
    for (const forward of forwards) forward.rejectSetup?.(error);
    session.cleanup = Promise.all(forwards.map((forward) => this.#releaseLocal(forward)));
    return session.cleanup;
  }

  async #releaseLocal(forward) {
    for (const resource of forward.resources) resource.destroy();
    forward.resources.clear();
    await closeServer(forward.server);
  }

  #log(session, level, message) {
    session.logs.push({ time: new Date().toISOString(), level, message: String(message).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500) });
    if (session.logs.length > 200) session.logs.splice(0, session.logs.length - 200);
  }

  #forwardView(forward) {
    const { id, name, direction, bindHost, bindPort, targetHost, targetPort, state, lastError, targetConnection } = forward;
    return { id, ...(name !== undefined && { name }), direction, bindHost, bindPort, targetHost, targetPort, state, ...(lastError && { lastError }),
      targetConnection: { ...targetConnection, ...(targetConnection.error && { error: { ...targetConnection.error } }) } };
  }

  #view(session) {
    const { id, host, port, username, state, connectedAt, lastConnectedAt, hostFingerprint, lastError } = session;
    return {
      id, host, port, username, state, connectedAt, lastConnectedAt, hostFingerprint,
      logs: session.logs.map((entry) => ({ ...entry })),
      forwardErrors: [...session.forwardErrors.values()].map((entry) => ({ ...entry })),
      ...(lastError && { lastError }),
      ...(session.error && { error: { ...session.error } }),
      reconnect: { enabled: session.intent.enabled, state: session.intent.phase, attempts: session.intent.attempts,
        ...(session.intent.nextRetryAt && { nextRetryAt: session.intent.nextRetryAt }),
        ...(session.intent.reason && { reason: session.intent.reason }) },
      forwards: [...session.forwards.values()].map((forward) => this.#forwardView(forward)),
    };
  }
}
