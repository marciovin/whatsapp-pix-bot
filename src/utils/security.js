import { createHash, timingSafeEqual } from 'node:crypto';

/** Comparação em tempo constante (sem vazar o tamanho), para tokens e assinaturas. */
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a ?? '')).digest();
  const hb = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(ha, hb);
}

/** Mascara telefone para logs: 5511****99 */
export function maskPhone(phone) {
  const p = String(phone ?? '');
  return p.length <= 6 ? '***' : `${p.slice(0, 4)}****${p.slice(-2)}`;
}
