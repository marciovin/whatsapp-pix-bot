import { Router } from 'express';
import { createAsaasController } from '../controllers/asaasController.js';
import { createWhatsAppController } from '../controllers/whatsappController.js';
import { verifyMetaSignature } from '../middlewares/verifyMetaSignature.js';
import { webhookLimiter } from '../middlewares/rateLimit.js';

export function createRoutes(container) {
  const { config, store, payments, conversation, logger } = container;
  const router = Router();
  const whatsapp = createWhatsAppController({ config, conversation, logger });
  const asaas = createAsaasController({ payments });
  const limiter = webhookLimiter();

  router.get('/health', (_req, res) => res.json({ status: 'ok' }));
  router.get('/ready', async (_req, res) => {
    try {
      await store.ping();
      res.json({ status: 'ready' });
    } catch (err) {
      logger.error({ err: err.message }, 'readiness: banco indisponível');
      res.status(503).json({ status: 'unavailable' });
    }
  });

  router.get('/webhooks/whatsapp', whatsapp.verify);
  router.post('/webhooks/whatsapp', limiter, verifyMetaSignature(config.WHATSAPP_APP_SECRET), whatsapp.receive);
  router.post('/webhooks/asaas', limiter, asaas.receive);
  return router;
}
