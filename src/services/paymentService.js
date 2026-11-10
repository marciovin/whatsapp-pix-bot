import { HttpError } from '../utils/errors.js';
import { safeEqual } from '../utils/security.js';
import { asaasWebhookSchema } from '../validators/asaas.js';
import * as messages from './messages.js';

// Estados do Asaas que indicam dinheiro recebido (confirmar na documentação vigente do Asaas).
const PAID_STATUSES = new Set(['RECEIVED', 'CONFIRMED']);
const PAID_EVENTS = new Set(['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED']);

export function createPaymentService({ store, provider, config, logger }) {
  /** Cria a cobrança PIX no Asaas e a associa ao pedido. */
  async function createCharge(order, { cpf }) {
    const charge = await provider.createPixCharge({
      customerName: order.customerName ?? `Cliente ${order.customerPhone.slice(-4)}`,
      cpfCnpj: cpf,
      mobilePhone: order.customerPhone.replace(/^55/, ''),
      valueCents: order.totalCents,
      externalReference: order.id,
      description: `Pedido #${order.orderNumber} - ${config.STORE_NAME}`.slice(0, 500),
    });
    try {
      await store.attachCharge(order.id, {
        chargeId: charge.chargeId,
        amountCents: order.totalCents,
        pixPayload: charge.pixPayload,
        expiresAt: charge.expiresAt,
      });
    } catch (err) {
      await provider.cancelCharge(charge.chargeId).catch(() => {});
      throw err;
    }
    return charge;
  }

  const ownerAlertItem = (key, text) => ({
    kind: 'OWNER_ALERT',
    to: config.OWNER_WHATSAPP_NUMBER,
    dedupeKey: key,
    payload: { text: messages.ownerAlert(text) },
  });

  function ownerSummaryItem(order, payment) {
    const payload = { text: messages.ownerSummary(order, payment) };
    if (config.OWNER_NOTIFY_TEMPLATE) {
      payload.template = {
        name: config.OWNER_NOTIFY_TEMPLATE,
        language: config.OWNER_NOTIFY_TEMPLATE_LANG,
        params: [messages.ownerSummaryOneLine(order, payment)],
      };
    }
    return { kind: 'OWNER_ORDER_SUMMARY', to: config.OWNER_WHATSAPP_NUMBER, dedupeKey: `order:${order.id}:owner-summary`, payload };
  }

  /** Compara o estado REAL da cobrança no Asaas com o que esperamos do pedido. */
  function inspectRemote(order, remote) {
    const payment = order.payment;
    if (remote.id !== payment.chargeId) return { problem: 'MISMATCH_CHARGE' };
    if (remote.externalReference !== order.id) return { problem: 'MISMATCH_ORDER' };
    if (remote.valueCents !== order.totalCents || remote.valueCents !== payment.amountCents) return { problem: 'MISMATCH_VALUE' };
    return { problem: null, paid: PAID_STATUSES.has(remote.status) };
  }

  /** Verifica no Asaas e, se (e só se) estiver pago e consistente, confirma o pedido atomicamente. */
  async function verifyAndConfirm(order) {
    if (!order.payment) return { result: 'NO_CHARGE' };
    const remote = await provider.getPayment(order.payment.chargeId);
    const { problem, paid } = inspectRemote(order, remote);

    if (problem) {
      logger.error({ orderId: order.id, chargeId: order.payment.chargeId, problem, remoteStatus: remote.status }, 'cobrança inconsistente com o pedido');
      await store.flagPaymentAnomaly(order.payment.chargeId, problem);
      if (PAID_STATUSES.has(remote.status)) {
        await store.enqueueOutbox([
          ownerAlertItem(`alert:${order.id}:${problem}`, `Cobrança ${remote.id} aparece como paga, mas é inconsistente (${problem}) com o pedido #${order.orderNumber}. Pedido NÃO foi confirmado.`),
        ]);
      }
      return { result: problem };
    }
    if (!paid) return { result: 'NOT_PAID' };
    if (order.status === 'PAID') return { result: 'ALREADY_PAID' };

    if (order.status !== 'AWAITING_PAYMENT') {
      const problemKey = `PAID_AFTER_${order.status}`;
      await store.flagPaymentAnomaly(order.payment.chargeId, problemKey);
      await store.enqueueOutbox([
        ownerAlertItem(`alert:${order.id}:${problemKey}`, `Pagamento recebido (cobrança ${remote.id}) para o pedido #${order.orderNumber}, que estava ${order.status}. Verifique/estorne manualmente.`),
      ]);
      return { result: problemKey };
    }

    const { changed } = await store.confirmPayment({
      orderId: order.id,
      chargeId: order.payment.chargeId,
      outbox: [
        ownerSummaryItem(order, order.payment),
        { kind: 'CUSTOMER_PAID', to: order.customerPhone, dedupeKey: `order:${order.id}:customer-paid`, payload: { text: messages.paidCustomer(order) } },
      ],
    });
    return { result: changed ? 'CONFIRMED' : 'ALREADY_PAID' };
  }

  async function expire(order) {
    if (order.status !== 'AWAITING_PAYMENT' || !order.payment) return { result: 'ALREADY_FINAL' };
    const remote = await provider.getPayment(order.payment.chargeId);
    if (remote.status !== 'OVERDUE') return { result: 'NOT_OVERDUE' };
    const { changed } = await store.expireOrder({
      orderId: order.id,
      chargeId: order.payment.chargeId,
      outbox: [{ kind: 'CUSTOMER_EXPIRED', to: order.customerPhone, dedupeKey: `order:${order.id}:customer-expired`, payload: { text: messages.expiredCustomer(order) } }],
    });
    return { result: changed ? 'EXPIRED' : 'ALREADY_FINAL' };
  }

  async function processEvent(event, chargeId) {
    const order = await store.getOrderByChargeId(chargeId);
    if (!order) {
      logger.warn({ chargeId, event }, 'webhook para cobrança desconhecida');
      return { result: 'UNKNOWN_CHARGE' };
    }
    if (PAID_EVENTS.has(event)) return verifyAndConfirm(order);
    if (event === 'PAYMENT_OVERDUE') return expire(order);
    return { result: 'IGNORED' };
  }

  /** Autentica, valida, registra (idempotente) e processa um webhook do Asaas. */
  async function handleWebhook({ token, body }) {
    if (!token || !safeEqual(token, config.ASAAS_WEBHOOK_TOKEN)) throw new HttpError(401, 'token inválido');
    const parsed = asaasWebhookSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, 'payload inválido');
    const { event, payment } = parsed.data;
    const eventId = parsed.data.id ?? `${event}:${payment.id}`;

    const rec = await store.recordPaymentEvent({ eventId, event, chargeId: payment.id });
    if (!rec.created && rec.status === 'PROCESSED') return { result: 'DUPLICATE' };

    let outcome;
    try {
      outcome = await processEvent(event, payment.id);
    } catch (err) {
      await store.markPaymentEvent(eventId, 'RECEIVED', `erro: ${err.message}`.slice(0, 200));
      throw err; // 500 → o Asaas reenvia; o processamento é idempotente
    }
    await store.markPaymentEvent(eventId, 'PROCESSED', outcome.result);
    logger.info({ eventId, event, chargeId: payment.id, result: outcome.result }, 'webhook asaas processado');
    return outcome;
  }

  /** Cliente disse "paguei"/"status": não confiamos na mensagem, consultamos o Asaas. */
  async function reconcileOrder(orderId) {
    const order = await store.getOrder(orderId);
    if (!order) return { result: 'NOT_FOUND' };
    if (order.status === 'PAID') return { result: 'ALREADY_PAID' };
    if (order.status !== 'AWAITING_PAYMENT') return { result: 'ALREADY_FINAL' };
    return verifyAndConfirm(order);
  }

  /** Cancela a cobrança no Asaas (melhor esforço; o pedido já foi cancelado localmente). */
  async function cancelRemoteCharge(chargeId) {
    try {
      await provider.cancelCharge(chargeId);
    } catch (err) {
      logger.warn({ chargeId, err: err.message }, 'não foi possível cancelar a cobrança no Asaas');
    }
  }

  return { createCharge, handleWebhook, reconcileOrder, cancelRemoteCharge };
}
