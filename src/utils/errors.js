export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class WhatsAppError extends Error {
  constructor(message, { status = null, code = null, retryable = false } = {}) {
    super(message);
    this.name = 'WhatsAppError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export class AsaasError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'AsaasError';
    this.status = status;
    this.retryable = retryable;
  }
}
