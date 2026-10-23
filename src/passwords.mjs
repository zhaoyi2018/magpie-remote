import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { link, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { OperationError } from "./errors.mjs";

const algorithm = "aes-256-gcm";
const maximumPasswordLength = 4096;

export function validatePassword(password) {
  if (typeof password !== "string" || !password.length || password.length > maximumPasswordLength) {
    throw new Error("登录密码长度必须为 1–4096 个字符");
  }
  return password;
}

function bytes(value, length, maximum = length) {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4) throw new Error("密码密文格式无效");
  const result = Buffer.from(value, "base64");
  if (result.toString("base64") !== value || result.length < length || result.length > maximum) throw new Error("密码密文格式无效");
  return result;
}

export function validateEncryptedPassword(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 5 || value.version !== 1 || value.algorithm !== algorithm) throw new Error("密码密文格式无效");
  bytes(value.iv, 12);
  bytes(value.tag, 16);
  bytes(value.ciphertext, 1, maximumPasswordLength * 4);
  return { version: 1, algorithm, iv: value.iv, tag: value.tag, ciphertext: value.ciphertext };
}

// Bind ciphertext to this connection and endpoint so it cannot be moved to another server.
export const passwordContext = (profile) => JSON.stringify(["migpie-remote/password/v1", profile.id, profile.host, profile.port ?? 22, profile.username]);

export class PasswordVault {
  constructor(file) { this.file = file; }

  async encrypt(password, profile) {
    validatePassword(password);
    const key = await this.#key(true);
    const plaintext = Buffer.from(password, "utf8");
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv(algorithm, key, iv, { authTagLength: 16 });
      cipher.setAAD(Buffer.from(passwordContext(profile)));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { version: 1, algorithm, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
    } finally { key.fill(0); plaintext.fill(0); }
  }

  async decrypt(profile) {
    if (!profile.encryptedPassword) return undefined;
    let key, plaintext;
    try {
      const encrypted = validateEncryptedPassword(profile.encryptedPassword);
      key = await this.#key(false);
      const decipher = createDecipheriv(algorithm, key, bytes(encrypted.iv, 12), { authTagLength: 16 });
      decipher.setAAD(Buffer.from(passwordContext(profile)));
      decipher.setAuthTag(bytes(encrypted.tag, 16));
      plaintext = Buffer.concat([decipher.update(bytes(encrypted.ciphertext, 1, maximumPasswordLength * 4)), decipher.final()]);
      return validatePassword(plaintext.toString("utf8"));
    } catch (cause) {
      throw new OperationError("CREDENTIALS_REQUIRED", "已保存的密码无法解密，请输入本次密码，或编辑连接重新保存密码", { cause, credentialFields: ["password"] });
    } finally { key?.fill(0); plaintext?.fill(0); }
  }

  async #key(create) {
    try {
      try { return await this.#readKey(); }
      catch (error) { if (error.code !== "ENOENT" || !create) throw error; }
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      const key = randomBytes(32);
      try {
        await writeFile(temporary, key, { flag: "wx", mode: 0o600 });
        // Publish a complete key without ever replacing another writer's key.
        try { await link(temporary, this.file); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      } finally { key.fill(0); await rm(temporary, { force: true }).catch(() => {}); }
      return await this.#readKey();
    } catch (cause) {
      throw new OperationError("CONFIG_PASSWORD_KEY", "无法读取或创建本机密码密钥，请检查密钥文件、数据目录及访问权限", { cause });
    }
  }

  async #readKey() {
    const metadata = await lstat(this.file);
    if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o077))) throw new Error("密码密钥必须是仅当前用户可读写的普通文件");
    const key = await readFile(this.file);
    if (key.length !== 32) { key.fill(0); throw new Error("本机密码密钥格式无效"); }
    return key;
  }
}
