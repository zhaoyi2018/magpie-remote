import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OperationError } from "./errors.mjs";
import { loadRecoveryKey } from "./web-server.mjs";
import { isLANAddress, localGateway, magpieJSON, magpieSignIn, startProviderRelay } from "./local-gateway.mjs";
import { detectDirectGateway } from "./lan-detection.mjs";
import { remoteProviderAPI } from "./remote-http.mjs";

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

  constructor({ store, sessions, remote, directory, env = process.env, file = store.file + ".provider-link.json", intervalMs = 30000, detect = detectDirectGateway }) {
    Object.assign(this, { store, sessions, remote, directory, env, file, intervalMs, detect });
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
      if (![1, 2].includes(data.version) || data.identity !== this.#identity || !Array.isArray(data.records)) throw new Error("invalid provider link state");
      const records = new Map();
      for (const record of data.records) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(record.connectionId) || !/^[a-f0-9]{64}$/.test(record.binding) || records.has(record.connectionId)
          || (record.port !== undefined && (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535))) throw new Error("invalid provider link record");
        const providerId = "local-magpie-" + this.#identity;
        const active = data.version === 1 ? { mode: "ssh", endpoint: `http://127.0.0.1:${record.port}/${providerId}`, keyProof: this.#proof(this.#token()) } : record.mode ? { mode: record.mode, endpoint: record.endpoint, keyProof: record.keyProof } : undefined;
        if ((data.version === 1 && !record.port) || (!active && !record.pending)) throw new Error("invalid provider link record");
        for (const spec of [active, record.pending].filter(Boolean)) {
          const url = new URL(spec.endpoint);
          if (!["direct", "ssh"].includes(spec.mode) || url.protocol !== "http:" || url.username || url.password || url.search || url.hash
            || (spec.mode === "ssh" ? !url.port || Number(url.port) !== record.port || url.hostname !== "127.0.0.1" || url.pathname !== "/" + providerId : !isLANAddress(url.hostname.replace(/^\[|\]$/g, "")) || !["/", ""].includes(url.pathname))
            || !Array.isArray(spec.keyProof) || spec.keyProof.length !== 8 || spec.keyProof.some((value) => !/^[a-f0-9]{64}$/.test(value))) throw new Error("invalid managed provider");
        }
        records.set(record.connectionId, { connectionId: record.connectionId, binding: record.binding, ...(record.port && { port: record.port }), ...active, ...(record.pending && { pending: record.pending }) });
      }
      this.#records = records;
    } catch (error) { if (error.code !== "ENOENT") throw new OperationError("PROVIDER_LINK_STATE", "本机 Magpie 自动对接记录或密钥无法读取，请检查插件数据目录；未覆盖记录"); }
  }

  #save() {
    const contents = JSON.stringify({ version: 2, identity: this.#identity, records: [...this.#records.values()] }, null, 2) + "\n";
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
    const session = this.sessions.status(id, { includeLogs: false });
    if (session.state !== "connected") return { ...structuredClone(state), state: "disconnected", message: state.mode === "direct" ? "SSH 未连接，局域网供应商配置保留，直连状态待检测" : "SSH 未连接，本机 Magpie 对接通道已停止" };
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

  #token() { return createHmac("sha256", this.#secret).update("provider-relay:local-magpie-" + this.#identity).digest("base64url"); }

  #proof(key) { return Array.from({ length: 8 }, (_, index) => createHmac("sha256", this.#secret).update("provider-key:" + key.slice(-1 - index)).digest("hex")); }

  #matches(provider, spec) {
    if (!provider || !spec || provider.preset !== "remote-magpie" || rootOf(provider) !== spec.endpoint) return false;
    const expected = { chat: spec.endpoint + "/v1", responses: spec.endpoint + "/v1", anthropic: spec.endpoint };
    if (Object.entries(expected).some(([key, value]) => provider[key] && String(provider[key]).replace(/\/+$/, "") !== value)) return false;
    const tail = provider.key?.masked?.split("…").at(-1);
    if (typeof tail === "string") {
      if (!/^[\x21-\x7e]{1,8}$/.test(tail)) return false;
      const proof = createHmac("sha256", this.#secret).update("provider-key:" + tail).digest("hex");
      if (proof !== spec.keyProof[tail.length - 1]) return false;
    }
    return true;
  }

  async #persist(id, record) {
    const previous = this.#records.get(id);
    if (JSON.stringify(previous) === JSON.stringify(record)) return;
    this.#records.set(id, record);
    try { await this.#save(); }
    catch (error) { if (previous) this.#records.set(id, previous); else this.#records.delete(id); throw error; }
  }

  async #stopManagedForward(id) {
    const forward = this.sessions.status(id, { includeLogs: false }).forwards.find((item) => item.id === forwardId);
    if (!forward || forward.name !== "本机 Magpie 自动对接" || forward.direction !== "s2c" || forward.bindHost !== "127.0.0.1" || forward.targetHost !== "127.0.0.1"
      || forward.targetPort !== this.#relay?.port) return;
    this.sessions.forgetForward(id, forwardId);
    await this.sessions.removeForward(id, forwardId);
  }

  async #api(id, detection, signal) {
    if (detection.remoteHTTP && this.remote.managementLink) return remoteProviderAPI(this.sessions, id, await this.remote.managementLink(id), { signal });
    const web = await this.remote.web(id), signIn = await magpieSignIn(web.url, { signal });
    const cookie = signIn.cookies.map((value) => value.split(";")[0]).find((value) => /^[A-Za-z0-9_-]{1,128}=[A-Za-z0-9._~-]{16,256}$/.test(value));
    if (signIn.status !== 303 || !cookie) throw new OperationError("PROVIDER_LINK_AUTH", "无法通过 SSH 登录远端 Magpie 管理接口，请检查服务版本后重试");
    return (path, body) => magpieJSON(new URL(path, web.address), { signal, headers: { Cookie: cookie }, ...(body && { method: "POST", body }) });
  }

  start(dispatch) {
    this.#dispatch = dispatch;
    this.#timer = setInterval(() => {
      for (const session of this.sessions.status(undefined, { includeLogs: false })) if (session.state === "connected") void this.schedule(session.id);
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
    let directVerified = false;
    try {
      await this.#ready;
      const profile = await this.store.get(id);
      if (profile.autoLinkLocalMagpie === false) {
        await this.#stopManagedForward(id);
        return this.#state(id, "disabled", "已关闭自动对接本机 Magpie");
      }
      if (this.sessions.status(id).state !== "connected") return this.status(id);
      await this.remote.assertIdle(id);
      const instance = await this.remote.inspect(id, { signal: abort });
      if (instance.locked) return this.#state(id, "waiting", "等待远端管理操作结束后自动对接本机 Magpie");
      if (!instance.installed || !instance.web.enabled || instance.web.tls || instance.service.state !== "running") return this.#state(id, "waiting", "等待远端 Magpie 的回环 HTTP 管理服务就绪；请先启用 Web");
      const discovered = await localGateway(this.directory, this.env);
      const gateways = [];
      for (const address of [discovered.url, ...discovered.alternatives].slice(0, 16)) {
        if (abort.aborted) break;
        try {
          const info = await magpieJSON(address + "/", { signal: abort, timeoutMs: 3000, headers: { Authorization: "Bearer " + discovered.key, "x-api-key": discovered.key } });
          if (info?.name !== "magpie" || typeof info.version !== "string") continue;
          const url = new URL(address);
          gateways.push({ ...discovered, url: address, host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) || 80, info });
        } catch { /* Try the next assigned LAN interface, never loopback. */ }
      }
      if (!gateways.length) throw new OperationError("LOCAL_MAGPIE_UNAVAILABLE", "无法通过局域网地址与共享网关密钥访问本机 Magpie，请检查局域网共享、网关端口及密钥；不会改用 localhost");
      const detection = await this.detect(this.sessions, id, gateways, { signal: abort });
      directVerified = Boolean(detection.gateway);
      if (abort.aborted || this.sessions.status(id, { includeLogs: false }).state !== "connected") return this.status(id);
      const local = detection.gateway ?? gateways[0];
      const api = await this.#api(id, detection, abort);
      const providers = (await api("/api/providers"))?.providers;
      if (!Array.isArray(providers)) throw new OperationError("PROVIDER_LINK_API", "远端供应商列表结构不受支持");
      const providerId = "local-magpie-" + this.#identity;
      if (detection.gateway && !providers.some((item) => item.id === providerId)) {
        const manual = providers.find((item) => item.id !== providerId && item.preset === "remote-magpie" && rootOf(item) === local.url);
        if (manual) {
          await this.#stopManagedForward(id);
          const disabled = manual.off || manual.key?.set === false;
          return this.#state(id, disabled ? "disabled" : "ready", disabled ? "已有局域网供应商已停用或清除密钥，保留当前设置" : "已复用现有局域网供应商，无需 SSH 隧道", { mode: "direct", providerId: manual.id, endpoint: local.url, gatewayAddress: local.url, localAddress: local.url });
        }
      }
      // Existing explicit reverse forwards identify a manually added local gateway
      // without inferring identity from a provider's display name or a LAN IP.
      const forwards = this.sessions.status(id, { includeLogs: false }).forwards;
      for (const forward of detection.gateway ? [] : forwards) {
        if (forward.direction !== "s2c" || forward.state !== "listening" || forward.bindHost !== "127.0.0.1" || forward.targetHost !== local.host || forward.targetPort !== local.port) continue;
        const existing = providers.find((item) => item.preset === "remote-magpie" && rootOf(item) === "http://127.0.0.1:" + forward.bindPort);
        if (existing) return this.#state(id, existing.off ? "disabled" : "ready", existing.off ? "远端已存在本机 Magpie 供应商，但已停用；保留当前设置" : "远端已配置本机 Magpie 的局域网网关，已复用现有手动反向转发", { mode: "ssh", providerId: existing.id, forwardId: forward.id, endpoint: rootOf(existing), localAddress: local.url, gatewayAddress: local.url });
      }
      const token = this.#token();
      const existing = providers.find((item) => item.id === providerId);
      if (existing?.off || existing?.key?.set === false) {
        await this.#stopManagedForward(id);
        return this.#state(id, "disabled", "远端已存在本机 Magpie 供应商，但已停用或清除密钥；保留当前设置", { providerId });
      }
      const binding = digest([profile.id, profile.host, profile.port, profile.username]);
      const previous = this.#records.get(id), saved = previous?.binding === binding ? previous : undefined;
      let port = saved?.binding === binding ? saved.port : 0;
      if (existing) {
        let url;
        try { url = new URL(rootOf(existing)); } catch { /* Checked below. */ }
        const legacy = url?.hostname === "127.0.0.1" && url.pathname === "/" + providerId ? { mode: "ssh", endpoint: url.origin + url.pathname, keyProof: this.#proof(token) } : undefined;
        const known = saved ? [saved.pending, saved.mode && saved].filter(Boolean)
          : [legacy, ...gateways.map((gateway) => ({ mode: "direct", endpoint: gateway.url, keyProof: this.#proof(gateway.key) }))].filter(Boolean);
        if (!known.some((spec) => this.#matches(existing, spec))) throw new OperationError("PROVIDER_LINK_CONFLICT", "自动对接供应商的地址或密钥已被手动修改，保留现有配置；请检查后重试");
        if (!port && legacy) port = Number(url.port);
      }
      let forward, endpoint = local.url, key = local.key;
      const mode = detection.gateway ? "direct" : "ssh";
      if (mode === "ssh") {
        this.#relayReady ??= startProviderRelay();
        this.#relay = await this.#relayReady;
        this.#relay.set(providerId, token, local);
        forward = forwards.find((item) => item.id === forwardId);
        if (forward && (forward.name !== "本机 Magpie 自动对接" || forward.direction !== "s2c" || forward.bindHost !== "127.0.0.1" || forward.targetHost !== "127.0.0.1" || forward.targetPort !== this.#relay.port || (port && forward.bindPort !== port))) throw new OperationError("PROVIDER_LINK_CONFLICT", "自动对接转发标识已被其他规则占用，请检查端口转发列表");
        if (!forward) forward = await this.sessions.addForward(id, { id: forwardId, name: "本机 Magpie 自动对接", direction: "s2c", bindHost: "127.0.0.1", bindPort: port || 0, targetHost: "127.0.0.1", targetPort: this.#relay.port }, { signal: abort });
        this.sessions.forgetForward(id, forwardId);
        port = forward.bindPort;
        endpoint = `http://127.0.0.1:${port}/${providerId}`; key = token;
      }
      const desired = { mode, endpoint, keyProof: this.#proof(key) };
      const record = { connectionId: id, binding, ...(port && { port }) };
      const pendingConfirmed = saved?.pending && JSON.stringify(saved.pending) === JSON.stringify(desired) && this.#matches(existing, desired);
      if (!this.#matches(existing, desired) || (!pendingConfirmed && saved?.endpoint === endpoint && JSON.stringify(saved.keyProof) !== JSON.stringify(desired.keyProof))) {
        const currentProfile = await this.store.get(id);
        if (this.sessions.status(id).state !== "connected" || digest([currentProfile.id, currentProfile.host, currentProfile.port, currentProfile.username]) !== binding) throw new OperationError("PROVIDER_LINK_CONFLICT", "连接配置已变化，本次未写入远端供应商，请重新检测");
        await this.remote.assertIdle(id);
        await this.#persist(id, { ...record, ...(saved?.mode && { mode: saved.mode, endpoint: saved.endpoint, keyProof: saved.keyProof }), pending: desired });
        await api("/api/provider/save", { ...existing, id: providerId, name: existing?.name ?? (mode === "direct" ? "局域网 Magpie" : "局域网 Magpie（SSH）"), preset: "remote-magpie", chat: endpoint + "/v1", responses: endpoint + "/v1", anthropic: endpoint, key, proxy: existing?.proxy ?? "direct", new: false });
        const verified = (await api("/api/providers"))?.providers;
        if (!Array.isArray(verified) || !verified.some((item) => item.id === providerId && this.#matches(item, desired))) throw new OperationError("PROVIDER_LINK_API", "尚未确认远端已保存本机 Magpie 供应商，将在下次检测时核实");
      }
      await this.#persist(id, { ...record, ...desired });
      if (mode === "direct") await this.#stopManagedForward(id);
      return this.#state(id, "ready", mode === "direct" ? "局域网直连已验证，直接访问本机 Magpie，无需 SSH 隧道" : "已通过 SSH 隧道对接本机 Magpie（" + detection.reason + "）", { mode, providerId, ...(forward && { forwardId }), endpoint, localAddress: local.url, gatewayAddress: local.url, ...(mode === "ssh" && { directReason: detection.reason }) });
    } catch (error) {
      if (error.code?.startsWith("LOCAL_MAGPIE_")) this.#relay?.remove("local-magpie-" + this.#identity);
      if (this.#closed) return this.status(id);
      if (error.code === "REMOTE_BUSY") return this.#state(id, "waiting", "等待远端任务结束后自动对接本机 Magpie");
      const message = error instanceof OperationError ? error.message : "自动对接暂未完成，请检查本机网关、远端 Web 服务和 SSH 转发权限；稍后自动重试";
      return this.#state(id, "error", directVerified && ["PROVIDER_LINK_HTTP", "PROVIDER_LINK_AUTH", "PROVIDER_LINK_API"].includes(error.code)
        ? "本机局域网网关直连验证已通过；" + message : message);
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
