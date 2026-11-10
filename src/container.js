import { createConversationService } from './services/conversationService.js';
import { createOutboxWorker } from './services/outboxWorker.js';
import { createPaymentService } from './services/paymentService.js';

/** Monta os serviços a partir de dependências injetáveis (reais em produção, falsas nos testes). */
export function createContainer({ config, store, wa, asaas, catalogProvider, logger }) {
  const payments = createPaymentService({ store, provider: asaas, config, logger });
  const conversation = createConversationService({ store, catalogProvider, payments, wa, config, logger });
  const outbox = createOutboxWorker({ store, wa, config, logger });
  return { config, store, wa, payments, conversation, outbox, logger };
}
