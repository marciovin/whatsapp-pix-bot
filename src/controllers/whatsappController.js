import { maskPhone, safeEqual } from '../utils/security.js';
import { extractMessages } from '../validators/whatsapp.js';

export function createWhatsAppController({ config, conversation, logger }) {
  return {
    /** Verificação inicial do webhook (GET com hub.*). */
    verify(req, res) {
      const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
      if (mode === 'subscribe' && typeof token === 'string' && safeEqual(token, config.WHATSAPP_VERIFY_TOKEN)) {
        return res.status(200).type('text/plain').send(String(challenge ?? ''));
      }
      return res.sendStatus(403);
    },

    /** Eventos (POST). Responde 200 logo e processa em segundo plano, em ordem. */
    receive(req, res) {
      const messages = extractMessages(req.body);
      res.sendStatus(200);
      (async () => {
        for (const m of messages) {
          try {
            await conversation.handleMessage(m);
          } catch (err) {
            logger.error({ from: maskPhone(m.from), err: err.message }, 'falha ao processar evento do WhatsApp');
          }
        }
      })();
    },
  };
}
