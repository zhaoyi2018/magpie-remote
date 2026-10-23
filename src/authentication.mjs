import ssh2 from "ssh2";
import { readFile } from "node:fs/promises";
import { expandPath } from "./config.mjs";
import { OperationError } from "./errors.mjs";

function needsPassphrase(error) {
  return error instanceof Error && /encrypted.*no passphrase/i.test(error.message);
}

export function credentialRequest(issues) {
  const missing = issues.filter((issue) => issue.code === "CREDENTIALS_REQUIRED");
  if (!missing.length) return undefined;
  const credentialFields = [...new Set(missing.flatMap((issue) => issue.credentialFields))];
  return new OperationError("CREDENTIALS_REQUIRED", credentialFields.length > 1
    ? "请输入本次登录密码或私钥口令后重试"
    : missing[0].message, { credentialFields });
}

// Prepare each source independently: an unavailable fallback must not prevent a
// usable agent, key or password from reaching SSH authentication.
export async function prepareAuthentication(profile, env, credentials = {}, passwordVault) {
  const config = {}, issues = [];
  config.agent = profile.agent ?? env.SSH_AUTH_SOCK
    ?? (profile.authMethod === "agent" && process.platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : undefined);
  config.password = credentials.password || undefined;
  if (!config.password && profile.encryptedPassword) {
    try { config.password = await passwordVault?.decrypt(profile); }
    catch (error) { issues.push(error); }
  }
  config.password ||= (profile.passwordEnv && env[profile.passwordEnv]) || undefined;
  if (!config.password && (profile.passwordEnv || ["password", "environment"].includes(profile.authMethod))) {
    issues.push(new OperationError("CREDENTIALS_REQUIRED", profile.passwordEnv
      ? `环境变量 ${profile.passwordEnv} 未设置，请提供该变量或输入本次登录密码`
      : "请输入本次登录密码", { credentialFields: ["password"] }));
  }
  if (profile.identityFile) {
    try {
      const contents = await readFile(expandPath(profile.identityFile));
      const passphrase = credentials.passphrase || (profile.passphraseEnv && env[profile.passphraseEnv]) || undefined;
      let parsed = ssh2.utils.parseKey(contents, passphrase);
      if (parsed instanceof Error) {
        const encrypted = needsPassphrase(parsed) || (passphrase && needsPassphrase(ssh2.utils.parseKey(contents)));
        if (encrypted) throw new OperationError("CREDENTIALS_REQUIRED", passphrase
          ? "私钥口令不正确或加密私钥无法解密，请核对后重试"
          : "此私钥已加密，请输入私钥口令", { cause: parsed, credentialFields: ["passphrase"] });
        throw new OperationError("KEY_INVALID", "无法解析私钥，请检查私钥文件格式", { cause: parsed });
      }
      if (Array.isArray(parsed)) parsed = parsed[0];
      if (!parsed?.getPrivatePEM?.()) throw new OperationError("KEY_INVALID", "所选文件不包含可用的私钥");
      config.privateKey = contents;
      config.passphrase = passphrase;
    } catch (error) {
      issues.push(error instanceof OperationError ? error
        : new OperationError("KEY_UNAVAILABLE", "无法读取私钥，请检查文件路径和权限", { cause: error }));
    }
  }
  const methods = profile.authMethod === "agent" ? ["agent", "publickey", "password"]
    : profile.authMethod === "key" ? ["publickey", "password", "agent"] : ["password", "publickey", "agent"];
  const available = methods.filter((method) => method === "agent" ? config.agent : method === "publickey" ? config.privateKey : config.password);
  if (!available.length) {
    throw credentialRequest(issues) ?? issues[0]
      ?? new OperationError("CREDENTIALS_REQUIRED", "请输入本次登录密码，或配置可用的私钥 / SSH agent", { credentialFields: ["password"] });
  }
  config.authHandler = ["none", ...available];
  return { config, issues };
}
