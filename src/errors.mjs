export class OperationError extends Error {
  constructor(code, message, { cause, credentialFields } = {}) {
    super(message, { cause });
    this.code = code;
    this.category = code.startsWith("CONFIG_") ? "configuration"
      : code.startsWith("HOST_KEY_") ? "trust"
      : ["CREDENTIALS_REQUIRED", "KEY_INVALID", "KEY_UNAVAILABLE"].includes(code) ? "credentials"
      : code === "SSH_AUTH_FAILED" ? "authentication"
      : ["SSH_NETWORK", "SSH_TIMEOUT", "SSH_DISCONNECTED"].includes(code) ? "network"
      : code.startsWith("FORWARD_") ? "forward"
      : code === "OPERATION_CANCELLED" ? "cancelled" : "operation";
    this.retryable = this.category === "network";
    if (credentialFields) this.credentialFields = credentialFields;
  }
}

export function errorDetails(error) {
  return {
    code: error.code ?? "OPERATION_FAILED", message: error.message,
    category: error.category ?? "operation", retryable: error.retryable === true,
  };
}

const networkCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "ENETDOWN", "ENETUNREACH", "EHOSTDOWN", "EHOSTUNREACH", "EAI_AGAIN"]);
export function sshFailure(error) {
  if (error instanceof OperationError) return error;
  if (error.level === "client-authentication" || error.level === "agent") {
    return new OperationError("SSH_AUTH_FAILED", "SSH 认证失败，请检查用户名和凭据：" + error.message, { cause: error });
  }
  if (error.level === "client-timeout" || error.code === "ETIMEDOUT") {
    return new OperationError("SSH_TIMEOUT", "SSH 连接超时，请检查服务器地址和网络", { cause: error });
  }
  if (networkCodes.has(error.code)) {
    return new OperationError("SSH_NETWORK", "SSH 网络连接中断或暂不可用：" + error.message, { cause: error });
  }
  return new OperationError("SSH_CONNECTION_FAILED", "SSH 连接失败：" + error.message, { cause: error });
}
