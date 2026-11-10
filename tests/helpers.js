import { randomUUID } from 'node:crypto';
import { createStaticCatalogProvider } from '../src/config/catalog.js';
import { createContainer } from '../src/container.js';
import { createMemoryStore } from '../src/repositories/memoryStore.js';
import { WhatsAppError } from '../src/utils/errors.js';

export const WEBHOOK_TOKEN = 'webhook-token-with-at-least-32-characters!!';
export const APP_SECRET = 'meta-app-secret-for-tests';
export const VERIFY_TOKEN = 'verify-token-for-tests-123';
export const OWNER = '5524999990000';
export const CUSTOMER = '5524988887777';
export const VALID_CPF = '52998224725';

export const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

export const baseConfig = {
  NODE_ENV: 'test',
  TRUST_PROXY: 0,
  STORE_NAME: 'Loja Teste',
  OWNER_WHATSAPP_NUMBER: OWNER,
  OWNER_NOTIFY_TEMPLATE: undefined,
  OWNER_NOTIFY_TEMPLATE_LANG: 'pt_BR',
  ASAAS_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
  WHATSAPP_APP_SECRET: APP_SECRET,
  WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
  OUTBOX_MAX_ATTEMPTS: 5,
};

/** Provedor Asaas simulado (nenhuma chamada de rede, nenhum dinheiro). */
export function createFakeAsaas() {
  const charges = new Map();
  let seq = 0;
  return {
    charges,
    async createPixCharge({ valueCents, externalReference }) {
      seq += 1;
      const chargeId = `pay_test_${seq}`;
      charges.set(chargeId, { id: chargeId, status: 'PENDING', valueCents, externalReference });
      return { chargeId, pixPayload: `00020126PIXCOPIAECOLA${seq}`, qrImageBase64: 'iVBORw0KGgo=', expiresAt: null };
    },
    async getPayment(chargeId) { return { ...charges.get(chargeId) }; },
    async cancelCharge(chargeId) { charges.get(chargeId).status = 'DELETED'; },
    // controles de teste
    setStatus(chargeId, status) { charges.get(chargeId).status = status; },
    patch(chargeId, fields) { Object.assign(charges.get(chargeId), fields); },
  };
}

/** WhatsApp simulado: registra o que seria enviado e permite injetar falhas. */
export function createFakeWhatsApp() {
  const sent = [];
  let failures = [];
  const maybeFail = () => { if (failures.length) throw failures.shift(); };
  return {
    sent,
    failNext(n, { retryable = true } = {}) {
      failures = Array.from({ length: n }, () => new WhatsAppError('falha simulada', { status: retryable ? 503 : 400, retryable }));
    },
    async sendText(to, body) { maybeFail(); sent.push({ kind: 'text', to, body }); },
    async sendTemplate(to, template) { maybeFail(); sent.push({ kind: 'template', to, template }); },
    async sendImage(to, opts) { sent.push({ kind: 'image', to, ...opts }); },
    to: (phone) => sent.filter((s) => s.to === phone),
  };
}

export function makeCtx(configOverrides = {}) {
  const config = { ...baseConfig, ...configOverrides };
  const store = createMemoryStore();
  const wa = createFakeWhatsApp();
  const asaas = createFakeAsaas();
  const container = createContainer({ config, store, wa, asaas, catalogProvider: createStaticCatalogProvider(), logger: silentLogger });
  return { ...container, config, store, wa, asaas };
}

export const chat = (ctx, text, from = CUSTOMER) =>
  ctx.conversation.handleMessage({ id: `wamid.${randomUUID()}`, from, name: 'Maria', type: 'text', text });

/** Conduz o cliente do primeiro "oi" até o PIX gerado (2x item 1 + 1x item 2 = R$ 45,50). */
export async function placeOrder(ctx, from = CUSTOMER) {
  await chat(ctx, 'oi', from);
  await chat(ctx, '1x2, 2', from);
  await chat(ctx, 'finalizar', from);
  await chat(ctx, 'Rua das Flores, 123, Centro, Resende - RJ', from);
  await chat(ctx, VALID_CPF, from);
  await chat(ctx, 'sim', from);
  const order = ctx.store._orders().find((o) => o.customerPhone === from && o.status === 'AWAITING_PAYMENT');
  return order;
}

export const paidWebhook = (chargeId, id = `evt_${randomUUID()}`, event = 'PAYMENT_RECEIVED') => ({
  token: WEBHOOK_TOKEN,
  body: { id, event, payment: { id: chargeId } },
});

export const ownerSummaries = (ctx) => ctx.store._outbox().filter((o) => o.kind === 'OWNER_ORDER_SUMMARY');
