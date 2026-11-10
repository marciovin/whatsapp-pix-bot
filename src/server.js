import 'dotenv/config';
import { createApp } from './app.js';
import { createStaticCatalogProvider } from './config/catalog.js';
import { createPrisma } from './config/db.js';
import { loadConfig } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createContainer } from './container.js';
import { createPrismaStore } from './repositories/prismaStore.js';
import { createAsaasClient } from './services/asaasClient.js';
import { createWhatsAppClient } from './services/whatsappClient.js';

const config = loadConfig();
const logger = createLogger(config);
config.warnings?.forEach((w) => logger.warn(w));

const prisma = createPrisma();
const store = createPrismaStore(prisma);

async function waitForDatabase(attempts = 10) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await store.ping();
      return;
    } catch (err) {
      logger.warn({ attempt: i, err: err.message }, 'banco indisponível; tentando novamente');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error('Banco de dados indisponível após várias tentativas');
}

await waitForDatabase();

const container = createContainer({
  config,
  store,
  logger,
  catalogProvider: createStaticCatalogProvider(),
  wa: createWhatsAppClient({
    accessToken: config.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
    apiVersion: config.WHATSAPP_API_VERSION,
  }),
  asaas: createAsaasClient({ apiKey: config.ASAAS_API_KEY, env: config.ASAAS_ENV }),
});

const server = createApp(container).listen(config.PORT, () => {
  logger.info({ port: config.PORT, asaasEnv: config.ASAAS_ENV }, 'servidor iniciado');
});
container.outbox.start();

async function shutdown(signal) {
  logger.info({ signal }, 'encerrando');
  container.outbox.stop();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
