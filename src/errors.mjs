export class OperationError extends Error {
  constructor(code, message, { cause, credentialFields } = {}) {
    super(message, { cause });
    this.code = code;
    if (credentialFields) this.credentialFields = credentialFields;
  }
}
