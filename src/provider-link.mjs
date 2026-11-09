import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OperationError } from "./errors.mjs";
import { loadRecoveryKey } from "./web-server.mjs";
import { localGateway, magpieJSON, magpieSignIn, startProviderRelay } from "./local-gateway.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const forwardId = "magpie-local-provider";
const rootOf = (provider) => String(provider.chat || provider.responses || provider.anthropic || "").replace(/\/+$/, "").replace(/\/v1$/, "");

export class ProviderLink {
  #records = new Map();
  #states = new Map();
  #tasks = new Map();
  #ready;
  #relay;
  #relayReady;
  #secret;
  #identity;
  #writes = Promise.resolve();
  #closed = false;
  #shutdown = new AbortController();
  #timer;
  #dispatch;

  constructor({ store, sessions, remote, directory, env = process.env, file = store.file + ".provider-link.json", intervalMs = 30000 }) {
    Object.assign(this, { store, sessions, remote, directory, env, file, intervalMs });
    this.#ready = this.#load();
    void this.#ready.catch(() => {});
  }

  async #load() {
    const key = await loadRecoveryKey(this.file + ".key");
    this.#secret = key.secret;
    this.#identity = createHmac("sha256", this.#secret).update("magpie-remote-local-provider").digest("hex").slice(0, 16);
    try {
      const text = await readFile(this.file, "utf8");
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("large provider link state");
      const data = JSON.parse(text);
      if (data.version !== 1 || data.identity !== this.#identity || !Array.isArray(data.records)) throw new Error("invalid provider link state");
      for (const record of data.records) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(record.connectionId) || !/^[a-f0-9]{64}$/.test(record.binding) || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || this.#records.has(record.connectionId)) throw new Error("invalid provider link record");
        this.#records.set(record.connectionId, { connectionId: record.connectionId, binding: record.binding, port: record.port });
      }
    } catch (error) { if (error.code !== "ENOENT") throw new OperationError("PROVIDER_LINK_STATE", "本机 Magpie 自动对接记录或密钥无法读取，请检查插件数据目录；未覆盖记录"); }
  }

  #save() {
    const contents = JSON.stringify({ version: 1, identity: this.#identity, records: [...this.#records.values()] }, null, 2) + "\n";
    const task = this.#writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
        for (let attempt = 0; ; attempt++) {
          try { await rename(temporary, this.file); break; }
          catch (error) { if (process.platform !== "win32" || !["EPERM", "EBUSY"].includes(error.code) || attempt >= 4) throw error; await delay(10 * (attempt + 1)); }
        }
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    this.#writes = task;
    return task;
  }

  status(id) {
    const state = this.#states.get(id) ?? { state: "waiting", message: "SSH 连接后自动检测并对接本机 Magpie" };
    const session = this.sessions.status(id);
    if (session.state !== "connected") return { ...structuredClone(state), state: "disconnected", message: "SSH 未连接，本机 Magpie 对接通道已停止" };
    if (state.state === "ready" && state.forwardId && !session.forwards.some((forward) => forward.id === state.forwardId && forward.state === "listening")) return { ...structuredClone(state), state: "waiting", message: "本机 Magpie 的反向通道尚未恢复，将自动重试" };
    return structuredClone(state);
  }

  #state(id, state, message, details = {}) {
    const previous = this.#states.get(id);
    const next = { state, message, ...details, checkedAt: new Date().toISOString() };
    this.#states.set(id, next);
    if (state !== "checking" && (previous?.state !== state || previous?.message !== message)) this.sessions.recordLog?.(id, state === "error" ? "warn" : "info", "本机 Magpie 对接：" + message);
    return structuredClone(next);
  }

  start(dispatch) {
    this.#dispatch = dispatch;
    this.#timer = setInterval(() => {
      for (const session of this.sessions.status()) if (session.state === "connected") void this.schedule(session.id);
    }, this.intervalMs);
    this.#timer.unref?.();
  }

  schedule(id) {
    if (this.#closed) return Promise.resolve();
    if (this.#tasks.has(id)) return this.#tasks.get(id);
    const task = Promise.resolve().then(() => this.#dispatch(id)).catch(() => {}).finally(() => this.#tasks.delete(id));
    this.#tasks.set(id, task);
    return task;
  }

  async sync(id, { signal } = {}) {
    if (this.#closed) return this.status(id);
    const abort = signal ? AbortSignal.any([signal, this.#shutdown.signal]) : this.#shutdown.signal;
    try {
      await this.#ready;
      const profile = await this.store.get(id);
      if (profile.autoLinkLocalMagpie === false) {
        const forward = this.sessions.status(id).forwards.find((item) => item.id === forwardId && item.name === "本机 Magpie 自动对接" && item.direction === "s2c" && item.targetPort === this.#relay?.port);
        if (forward) { this.sessions.forgetForward(id, forwardId); await this.sessions.removeForward(id, forwardId); }
        return this.#state(id, "disabled", "已关闭自动对接本机 Magpie");
      }
      if (this.sessions.status(id).state !== "connected") return this.status(id);
      await this.remote.assertIdle(id);
      const instance = await this.remote.inspect(id, { signal: abort });
      if (instance.locked) return this.#state(id, "waiting", "等待远端管理操作结束后自动对接本机 Magpie");
      if (!instance.installed || !instance.web.enabled || instance.web.tls || instance.service.state !== "running") return this.#state(id, "waiting", "等待远端 Magpie 的回环 HTTP 管理服务就绪；请先启用 Web");
      const discovered = await localGateway(this.directory, this.env);
      let local;
      for (const address of [discovered.url, ...discovered.alternatives]) {
        if (abort.aborted) break;
        try {
          const info = await magpieJSON(address + "/", { signal: abort, timeoutMs: 3000, headers: { Authorization: "Bearer " + discovered.key, "x-api-key": discovered.key } });
          if (info?.name !== "magpie" || typeof info.version !== "string") continue;
          const url = new URL(address);
          local = { ...discovered, url: address, host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) || 80 };
          break;
        } catch { /* Try the next assigned LAN interface, never loopback. */ }
      }
      if (!local) throw new OperationError("LOCAL_MAGPIE_UNAVAILABLE", "无法通过局域网地址与共享网关密钥访问本机 Magpie，请检查局域网共享、网关端口及密钥；不会改用 localhost");
      const web = await this.remote.web(id);
      const signIn = await magpieSignIn(web.url, { signal: abort });
      const cookie = signIn.cookies.map((value) => value.split(";")[0]).find((value) => /^[A-Za-z0-9_-]{1,128}=[A-Za-z0-9._~-]{16,256}$/.test(value));
      if (signIn.status !== 303 || !cookie) throw new OperationError("PROVIDER_LINK_AUTH", "无法通过 SSH 登录远端 Magpie 管理接口，请检查服务版本后重试");
      const api = (path, body) => magpieJSON(new URL(path, web.address), { signal: abort, headers: { Cookie: cookie }, ...(body && { method: "POST", body }) });
      const providers = (await api("/api/providers"))?.providers;
      if (!Array.isArray(providers)) throw new OperationError("PROVIDER_LINK_API", "远端供应商列表结构不受支持");
      // Existing explicit reverse forwards identify a manually added local gateway
      // without inferring identity from a provider's display name or a LAN IP.
      const forwards = this.sessions.status(id).forwards;
      for (const forward of forwards) {
        if (forward.direction !== "s2c" || forward.state !== "listening" || forward.bindHost !== "127.0.0.1" || forward.targetHost !== local.host || forward.targetPort !== local.port) continue;
        const existing = providers.find((item) => item.preset === "remote-magpie" && rootOf(item) === "http://127.0.0.1:" + forward.bindPort);
        if (existing) return this.#state(id, existing.off ? "disabled" : "ready", existing.off ? "远端已存在本机 Magpie 供应商，但已停用；保留当前设置" : "远端已配置本机 Magpie 的局域网网关，已复用现有反向转发", { providerId: existing.id, forwardId: forward.id, endpoint: rootOf(existing), localAddress: local.url, gatewayAddress: local.url });
      }
      const providerId = "local-magpie-" + this.#identity;
      const token = createHmac("sha256", this.#secret).update("provider-relay:" + providerId).digest("base64url");
      const existing = providers.find((item) => item.id === providerId);
      if (existing?.off || existing?.key?.set === false) return this.#state(id, "disabled", "远端已存在本机 Magpie 供应商，但已停用或清除密钥；保留当前设置", { providerId });
      const binding = digest([profile.id, profile.host, profile.port, profile.username]);
      const saved = this.#records.get(id);
      let port = saved?.binding === binding ? saved.port : 0;
      if (existing) {
        let url;
        try { url = new URL(rootOf(existing)); } catch { /* Checked below. */ }
        if (existing.preset !== "remote-magpie" || url?.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" + providerId || !url.port || url.username || url.password || url.search || url.hash || (port && Number(url.port) !== port)) throw new OperationError("PROVIDER_LINK_CONFLICT", "自动对接供应商已被手动修改，保留现有配置；请检查其地址后重试");
        port = Number(url.port);
        const keyTail = existing.key?.masked?.split("…").at(-1);
        if (typeof keyTail === "string" && /^[A-Za-z0-9_-]{4,8}$/.test(keyTail) && !token.endsWith(keyTail)) throw new OperationError("PROVIDER_LINK_CONFLICT", "自动对接供应商的密钥已被修改，保留现有配置；请检查其密钥后重试");
      }
      this.#relayReady ??= startProviderRelay();
      this.#relay = await this.#relayReady;
      this.#relay.set(providerId, token, local);
      let forward = forwards.find((item) => item.id === forwardId);
      if (forward && (forward.name !== "本机 Magpie 自动对接" || forward.direction !== "s2c" || forward.bindHost !== "127.0.0.1" || forward.targetHost !== "127.0.0.1" || forward.targetPort !== this.#relay.port || (port && forward.bindPort !== port))) throw new OperationError("PROVIDER_LINK_CONFLICT", "自动对接转发标识已被其他规则占用，请检查端口转发列表");
      if (!forward) forward = await this.sessions.addForward(id, { id: forwardId, name: "本机 Magpie 自动对接", direction: "s2c", bindHost: "127.0.0.1", bindPort: port, targetHost: "127.0.0.1", targetPort: this.#relay.port });
      // The integration recreates this forward after reconnect with the saved
      // actual port. A stale dynamic preset must not roll back SSH authentication.
      this.sessions.forgetForward(id, forwardId);
      const endpoint = `http://127.0.0.1:${forward.bindPort}/${providerId}`;
      const record = { connectionId: id, binding, port: forward.bindPort };
      if (JSON.stringify(saved) !== JSON.stringify(record)) {
        this.#records.set(id, record);
        try { await this.#save(); }
        catch (error) { if (saved) this.#records.set(id, saved); else this.#records.delete(id); throw error; }
      }
      if (!existing) {
        const currentProfile = await this.store.get(id);
        if (this.sessions.status(id).state !== "connected" || digest([currentProfile.id, currentProfile.host, currentProfile.port, currentProfile.username]) !== binding) throw new OperationError("PROVIDER_LINK_CONFLICT", "连接配置已变化，本次未写入远端供应商，请重新检测");
        await this.remote.assertIdle(id);
        await api("/api/provider/save", { id: providerId, name: "局域网 Magpie（SSH）", preset: "remote-magpie", chat: endpoint + "/v1", responses: endpoint + "/v1", anthropic: endpoint, key: token, proxy: "direct", new: false });
        const verified = (await api("/api/providers"))?.providers;
        if (!Array.isArray(verified) || !verified.some((item) => item.id === providerId && item.preset === "remote-magpie" && rootOf(item) === endpoint)) throw new OperationError("PROVIDER_LINK_API", "尚未确认远端已保存本机 Magpie 供应商，将在下次检测时核实");
      }
      return this.#state(id, "ready", existing ? "本机 Magpie 局域网网关已对接，SSH 反向通道正常" : "已将本机 Magpie 的局域网网关加入远端供应商，并建立 SSH 反向通道", { providerId, forwardId, endpoint, localAddress: local.url, gatewayAddress: local.url });
    } catch (error) {
      if (error.code?.startsWith("LOCAL_MAGPIE_")) this.#relay?.remove("local-magpie-" + this.#identity);
      if (this.#closed) return this.status(id);
      if (error.code === "REMOTE_BUSY") return this.#state(id, "waiting", "等待远端任务结束后自动对接本机 Magpie");
      const message = error instanceof OperationError ? error.message : "自动对接暂未完成，请检查本机网关、远端 Web 服务和 SSH 转发权限；稍后自动重试";
      return this.#state(id, "error", message);
    }
  }

  async forget(id) { await this.#ready; this.#records.delete(id); this.#states.delete(id); await this.#save(); }

  async close() {
    this.#closed = true; this.#shutdown.abort(); clearInterval(this.#timer);
    await Promise.allSettled([...this.#tasks.values()]);
    await this.#ready.catch(() => {});
    await this.#writes.catch(() => {});
    await this.#relay?.close();
  }
}
