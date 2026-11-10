import rateLimit from 'express-rate-limit';

export const webhookLimiter = () =>
  rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false, message: { error: 'muitas requisições' } });
