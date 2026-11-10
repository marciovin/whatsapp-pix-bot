import express from 'express';
import helmet from 'helmet';
import { errorHandler, notFound } from './middlewares/errorHandler.js';
import { createRoutes } from './routes/index.js';

export function createApp(container) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', container.config.TRUST_PROXY);
  app.use(helmet());
  // Guarda o corpo bruto: necessário para validar a assinatura HMAC da Meta.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(createRoutes(container));
  app.use(notFound);
  app.use(errorHandler(container.logger));
  return app;
}
