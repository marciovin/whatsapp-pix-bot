import { createHmac } from 'node:crypto';
import { safeEqual } from '../utils/security.js';

/** Valida X-Hub-Signature-256 (HMAC-SHA256 do corpo BRUTO com o App Secret da Meta). */
export function verifyMetaSignature(appSecret) {
  return (req, res, next) => {
    const header = req.get('x-hub-signature-256');
    if (!header || !req.rawBody) return res.status(401).json({ error: 'assinatura ausente' });
    const expected = `sha256=${createHmac('sha256', appSecret).update(req.rawBody).digest('hex')}`;
    if (!safeEqual(header, expected)) return res.status(401).json({ error: 'assinatura inválida' });
    return next();
  };
}
