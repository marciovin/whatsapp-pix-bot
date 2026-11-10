import { WhatsAppError } from '../utils/errors.js';

// Códigos de erro da Cloud API tratados como temporários (limite de taxa / indisponibilidade).
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 80007, 130429, 131056]);

export function createWhatsAppClient({ accessToken, phoneNumberId, apiVersion, fetchImpl = fetch }) {
  const base = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}`;

  async function call(path, init) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new WhatsAppError(`Falha de rede ao chamar a Cloud API: ${err.message}`, { retryable: true });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = data?.error?.code ?? null;
      const retryable = res.status === 429 || res.status >= 500 || RETRYABLE_CODES.has(code);
      throw new WhatsAppError(data?.error?.message ?? `HTTP ${res.status}`, { status: res.status, code, retryable });
    }
    return data;
  }

  const postMessage = (payload) =>
    call('/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
    });

  return {
    sendText: (to, body) => postMessage({ to, type: 'text', text: { preview_url: false, body } }),

    /** Template aprovado (necessário fora da janela de 24h). params = textos das variáveis {{1}}, {{2}}... */
    sendTemplate: (to, { name, language, params = [] }) =>
      postMessage({
        to,
        type: 'template',
        template: {
          name,
          language: { code: language },
          components: params.length
            ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }]
            : [],
        },
      }),

    /** Envia imagem (base64) via upload de mídia + mensagem de imagem. */
    async sendImage(to, { base64, mimeType = 'image/png', caption }) {
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', mimeType);
      form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: mimeType }), 'qrcode.png');
      const media = await call('/media', { method: 'POST', body: form });
      return postMessage({ to, type: 'image', image: { id: media.id, caption } });
    },
  };
}
