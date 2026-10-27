import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { identifier, validateProfile } from "./config.mjs";
import { OperationError } from "./errors.mjs";
import { PasswordVault, passwordContext, validatePassword } from "./passwords.mjs";

const backupID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const serialize = (profiles) => `${JSON.stringify({ version: 1, connections: profiles }, null, 2)}\n`;
export const profileRevision = (profile) => hash(JSON.stringify(validateProfile(profile)));
export function publicProfile(profile) {
  const { encryptedPassword, ...connection } = profile;
  return connection;
}

export function assertProfileRevision(current, expectedRevision) {
  if (expectedRevision !== undefined && expectedRevision !== null
    && (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision))) {
    throw new OperationError("CONFIG_REVISION_INVALID", "配置版本无效，请重新读取连接配置");
  }
  if (current && expectedRevision === undefined) {
    throw new OperationError("CONFIG_REVISION_REQUIRED", "修改已有配置前，请先读取 connections 返回的 revision，并作为 expectedRevision 提交");
  }
  if ((expectedRevision ?? null) !== (current ? profileRevision(current) : null)) {
    throw new OperationError("CONFIG_CONFLICT", "连接配置已被修改、删除或创建，本次操作未执行。请保留草稿，重新打开配置并对照后再保存");
  }
}

function decode(contents) {
  let data;
  try { data = JSON.parse(contents.toString("utf8")); }
  catch (cause) { throw new OperationError("CONFIG_INVALID", "无法读取连接配置文件，请检查 JSON 格式", { cause }); }
  if (!data || data.version !== 1 || !Array.isArray(data.connections)) throw new OperationError("CONFIG_INVALID", "连接配置文件的版本或结构无效，请修复后重试");
  let profiles;
  try { profiles = data.connections.map(validateProfile); }
  catch (cause) { throw new OperationError("CONFIG_INVALID", "连接配置文件中的配置无效：" + cause.message, { cause }); }
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) throw new OperationError("CONFIG_INVALID", "连接配置文件包含重复 id，请修复后重试");
  return profiles;
}

export class ProfileStore {
  #pending = Promise.resolve();
  #lastBackupTime = 0;
  #storageWarning = null;

  get storageWarning() { return structuredClone(this.#storageWarning); }

  constructor(file, { backupLimit = 5, renameFile = rename, removeFile = rm, onWarning = (warning) => console.warn(warning.message) } = {}) {
    this.file = file;
    this.renameFile = renameFile;
    this.removeFile = removeFile;
    this.onWarning = onWarning;
    this.passwordVault = new PasswordVault(file + ".key");
    this.backupDirectory = file + ".backups";
    if (!Number.isInteger(backupLimit) || backupLimit < 1 || backupLimit > 50) throw new Error("backupLimit 必须为 1–50");
    this.backupLimit = backupLimit;
  }

  async list() {
    const contents = await this.#readCurrent();
    if (contents === undefined) return [];
    try {
      return decode(contents);
    } catch (error) {
      throw new OperationError("CONFIG_INVALID", `${error.message}（${this.file}）`, { cause: error });
    }
  }

  async get(id) {
    identifier(id);
    const profile = (await this.list()).find((item) => item.id === id);
    if (!profile) throw new Error(`连接 ${id} 不存在`);
    return profile;
  }

  save(value, { expectedRevision, password } = {}) {
    const profile = validateProfile(value);
    if (password !== undefined) validatePassword(password);
    return this.#change(async (profiles) => {
      const index = profiles.findIndex((item) => item.id === profile.id);
      const current = profiles[index];
      assertProfileRevision(current, expectedRevision);
      delete profile.encryptedPassword;
      if (profile.authMethod === "password") {
        if (password !== undefined) profile.encryptedPassword = await this.passwordVault.encrypt(password, profile);
        else if (current?.encryptedPassword) {
          profile.encryptedPassword = passwordContext(current) === passwordContext(profile) ? current.encryptedPassword
            : await this.passwordVault.encrypt(await this.passwordVault.decrypt(current), profile);
        } else throw new OperationError("CREDENTIALS_REQUIRED", "请填写需要加密保存的登录密码", { credentialFields: ["password"] });
      } else if (password !== undefined) throw new Error("只有密码认证方式可以保存登录密码");
      if (index === -1) profiles.push(profile);
      else profiles[index] = profile;
      return profile;
    });
  }

  remove(id, { expectedRevision } = {}) {
    identifier(id);
    return this.#change(async (profiles) => {
      const index = profiles.findIndex((item) => item.id === id);
      assertProfileRevision(profiles[index], expectedRevision);
      if (index === -1) throw new Error(`连接 ${id} 不存在`);
      profiles.splice(index, 1);
      return { id, removed: true };
    });
  }

  importProfiles(values) {
    const incoming = values.map(validateProfile);
    if (new Set(incoming.map((profile) => profile.id)).size !== incoming.length) throw new Error("导入的连接 id 不能重复");
    return this.#change(async (profiles) => {
      const ids = new Set(profiles.map((profile) => profile.id));
      const imported = [], skipped = [];
      for (const profile of incoming) {
        if (ids.has(profile.id)) { skipped.push({ id: profile.id, reason: "连接已存在，未覆盖" }); continue; }
        profiles.push(profile); ids.add(profile.id); imported.push(profile);
      }
      return { imported, skipped };
    });
  }

  async listBackups() {
    let files;
    try { files = await readdir(this.backupDirectory); }
    catch (cause) {
      if (cause.code === "ENOENT") return [];
      throw new OperationError("CONFIG_BACKUP_UNREADABLE", "无法读取配置备份目录，请检查权限", { cause });
    }
    const backups = await Promise.all(files.filter((file) => file.endsWith(".json") && backupID.test(file.slice(0, -5))).map(async (file) => {
      const id = file.slice(0, -5);
      try {
        const { data, profiles } = await this.#readBackup(id);
        return { id, createdAt: data.createdAt, reason: data.reason, connectionCount: profiles.length, valid: true };
      } catch (error) { return { id, valid: false, error: error.message }; }
    }));
    return backups.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.id.localeCompare(b.id));
  }

  createBackup() {
    return this.#enqueue(async () => {
      const source = await this.#readCurrent();
      if (source === undefined) throw new OperationError("CONFIG_BACKUP_EMPTY", "尚无连接配置可备份");
      const backup = await this.#writeBackup(decode(source), "manual");
      await this.#pruneBackups();
      return backup;
    });
  }

  async previewRestore(id) { return (await this.#restorePlan(id)).preview; }

  restore(id, revision) {
    return this.#enqueue(async () => {
      const { preview, before, profiles } = await this.#restorePlan(id);
      if (typeof revision !== "string" || revision !== preview.revision) throw new OperationError("CONFIG_RESTORE_STALE", "配置或备份已变化，请重新预览后恢复");
      let preserved;
      if (before !== undefined) {
        if (preview.currentValid) preserved = { backupId: (await this.#writeBackup(decode(before), "before-restore")).id };
        else {
          const recoveryDirectory = this.file + ".recovery";
          const recoveryFile = join(recoveryDirectory, randomUUID() + ".json");
          try {
            await mkdir(recoveryDirectory, { recursive: true, mode: 0o700 });
            await writeFile(recoveryFile, before, { flag: "wx", mode: 0o600 });
          } catch (cause) { throw new OperationError("CONFIG_BACKUP_FAILED", "无法保留损坏的原配置，已取消恢复", { cause }); }
          preserved = { recoveryFile };
        }
      }
      await this.#commit(profiles, preserved?.backupId);
      return { restored: true, connectionCount: profiles.length, preserved };
    });
  }

  async #readCurrent() {
    try { return await readFile(this.file); }
    catch (cause) {
      if (cause.code === "ENOENT") return undefined;
      throw new OperationError("CONFIG_UNREADABLE", `无法读取连接配置文件 ${this.file}，请检查文件权限`, { cause });
    }
  }

  async #readBackup(id) {
    if (typeof id !== "string" || !backupID.test(id)) throw new OperationError("CONFIG_BACKUP_INVALID", "备份标识无效");
    try {
      const file = join(this.backupDirectory, id + ".json");
      if (!(await lstat(file)).isFile()) throw new Error("备份必须是普通文件");
      const source = await readFile(file);
      const profiles = decode(source);
      const data = JSON.parse(source);
      if (typeof data.createdAt !== "string" || !Number.isFinite(Date.parse(data.createdAt)) || !["automatic", "manual", "before-restore"].includes(data.reason)) throw new Error("备份信息无效");
      return { source, data, profiles };
    } catch (cause) { throw new OperationError("CONFIG_BACKUP_INVALID", "备份不可读或已损坏，请选择其他备份", { cause }); }
  }

  async #restorePlan(id) {
    const backup = await this.#readBackup(id);
    const before = await this.#readCurrent();
    let current = [], currentValid = true;
    try { current = before === undefined ? [] : decode(before); }
    catch { currentValid = false; }
    const revision = hash(JSON.stringify([id, hash(backup.source), before === undefined ? null : hash(before)]));
    const summarize = (profiles) => profiles.map(({ id, name }) => ({ id, name }));
    return { before, profiles: backup.profiles, preview: {
      backupId: id, createdAt: backup.data.createdAt, revision, currentValid,
      currentCount: currentValid ? current.length : null, connectionCount: backup.profiles.length,
      connections: summarize(backup.profiles),
      removed: currentValid ? summarize(current.filter((profile) => !backup.profiles.some((item) => item.id === profile.id))) : [],
    } };
  }

  async #writeBackup(profiles, reason) {
    const id = randomUUID();
    this.#lastBackupTime = Math.max(Date.now(), this.#lastBackupTime + 1);
    const createdAt = new Date(this.#lastBackupTime).toISOString();
    try {
      await this.#atomicWrite(join(this.backupDirectory, id + ".json"), JSON.stringify({ version: 1, createdAt, reason, connections: profiles }, null, 2) + "\n");
    } catch (cause) { throw new OperationError("CONFIG_BACKUP_FAILED", "配置备份失败，原配置未被替换，请检查目录权限和空间", { cause }); }
    return { id, createdAt, reason, connectionCount: profiles.length, valid: true };
  }

  #warn(cause) {
    const warning = new OperationError("CONFIG_BACKUP_CLEANUP_FAILED", "配置与备份已保留，但多余备份未能清理，将在下次成功写入后重试", { cause });
    this.#storageWarning = { code: warning.code, message: warning.message, observedAt: new Date().toISOString() };
    try { this.onWarning(warning); } catch { /* A warning must not turn a committed write into a failure. */ }
  }

  async #pruneBackups() {
    try {
      const valid = (await this.listBackups()).filter((item) => item.valid);
      for (const old of valid.slice(this.backupLimit)) await this.removeFile(join(this.backupDirectory, old.id + ".json"));
      this.#storageWarning = null;
    } catch (cause) { this.#warn(cause); }
  }

  async #commit(profiles, backupId) {
    try { await this.#atomicWrite(this.file, serialize(profiles)); }
    catch (error) {
      if (backupId) {
        try { await this.removeFile(join(this.backupDirectory, backupId + ".json"), { force: true }); }
        catch (cause) { this.#warn(cause); }
      }
      throw error;
    }
    await this.#pruneBackups();
  }

  async #atomicWrite(file, contents) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
      await this.renameFile(temporary, file);
    } catch (cause) { throw new OperationError("CONFIG_WRITE_FAILED", "无法保存连接配置，请检查目录权限和空间", { cause }); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  #change(update) {
    return this.#enqueue(async () => {
      const source = await this.#readCurrent();
      const profiles = source === undefined ? [] : decode(source);
      const before = structuredClone(profiles);
      const result = await update(profiles);
      if (source !== undefined && JSON.stringify(before) === JSON.stringify(profiles)) return result;
      const backup = source === undefined ? undefined : await this.#writeBackup(before, "automatic");
      await this.#commit(profiles, backup?.id);
      return result;
    });
  }

  #enqueue(action) {
    const operation = this.#pending.then(action);
    this.#pending = operation.catch(() => {});
    return operation;
  }
}
