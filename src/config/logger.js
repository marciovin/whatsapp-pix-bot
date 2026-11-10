import pino from 'pino';

export function createLogger(config) {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'whatsapp-pix-bot' },
    redact: {
      paths: [
        'req.headers.authorization',
        'headers.authorization',
        'headers["asaas-access-token"]',
        'headers["x-hub-signature-256"]',
        '*.access_token',
        '*.token',
        '*.cpf',
        '*.cpfCnpj',
      ],
      censor: '[REDACTED]',
    },
  });
}
