import { randomUUID } from 'node:crypto';

/**
 * Implementação em memória com a MESMA interface do prismaStore. Usada nos testes
 * (sem banco). As transições críticas não têm `await` internos, logo são atômicas.
 */
export function createMemoryStore() {
  const conversations = new Map();
  const inbound = new Set();
  const orders = new Map();
  const payments = new Map(); // por orderId
  const events = new Map();
  const outbox = [];
  let orderSeq = 0;

  const view = (order) => (order ? { ...structuredClone(order), payment: payments.has(order.id) ? structuredClone(payments.get(order.id)) : null } : null);
  const addOutbox = (items) => {
    for (const it of items) {
      if (outbox.some((o) => o.dedupeKey === it.dedupeKey)) continue;
      outbox.push({ id: randomUUID(), status: 'PENDING', attempts: 0, nextAttemptAt: new Date(0), lockedAt: null, lastError: null, sentAt: null, createdAt: new Date(), ...structuredClone(it) });
    }
  };
  const resetConversation = (phone) => {
    const c = conversations.get(phone);
    if (c) { c.state = 'IDLE'; c.context = {}; }
  };

  return {
    async ping() {},

    async claimInboundMessage(id) { if (inbound.has(id)) return false; inbound.add(id); return true; },
    async releaseInboundMessage(id) { inbound.delete(id); },

    async getConversation(phone) {
      if (!conversations.has(phone)) conversations.set(phone, { phone, state: 'IDLE', context: {} });
      return structuredClone(conversations.get(phone));
    },
    async saveConversation(phone, { state, context }) { conversations.set(phone, { phone, state, context: structuredClone(context) }); },

    async createOrder({ customerPhone, customerName, address, items, totalCents }) {
      orderSeq += 1;
      const order = { id: randomUUID(), orderNumber: orderSeq, customerPhone, customerName, address, items: structuredClone(items), totalCents, status: 'AWAITING_PAYMENT', paidAt: null, createdAt: new Date() };
      orders.set(order.id, order);
      return structuredClone(order);
    },
    async attachCharge(orderId, { chargeId, amountCents, pixPayload, expiresAt }) {
      payments.set(orderId, { orderId, chargeId, amountCents, pixPayload, pixExpiresAt: expiresAt ?? null, status: 'PENDING', anomaly: null, paidAt: null });
    },
    async getOrder(id) { return view(orders.get(id)); },
    async getOrderByChargeId(chargeId) {
      const p = [...payments.values()].find((x) => x.chargeId === chargeId);
      return p ? view(orders.get(p.orderId)) : null;
    },

    async cancelOrder(orderId) {
      const o = orders.get(orderId);
      if (!o || o.status !== 'AWAITING_PAYMENT') return false;
      o.status = 'CANCELED';
      if (payments.has(orderId)) payments.get(orderId).status = 'CANCELED';
      return true;
    },

    async recordPaymentEvent({ eventId, event, chargeId }) {
      if (events.has(eventId)) return { created: false, status: events.get(eventId).status };
      events.set(eventId, { eventId, event, chargeId, status: 'RECEIVED', note: null });
      return { created: true, status: 'RECEIVED' };
    },
    async markPaymentEvent(eventId, status, note) { Object.assign(events.get(eventId), { status, note }); },

    async confirmPayment({ orderId, chargeId, outbox: items }) {
      const o = orders.get(orderId);
      if (!o || o.status !== 'AWAITING_PAYMENT') return { changed: false };
      o.status = 'PAID';
      o.paidAt = new Date();
      Object.assign([...payments.values()].find((p) => p.chargeId === chargeId), { status: 'PAID', paidAt: new Date() });
      addOutbox(items);
      resetConversation(o.customerPhone);
      return { changed: true };
    },
    async expireOrder({ orderId, chargeId, outbox: items }) {
      const o = orders.get(orderId);
      if (!o || o.status !== 'AWAITING_PAYMENT') return { changed: false };
      o.status = 'EXPIRED';
      Object.assign([...payments.values()].find((p) => p.chargeId === chargeId), { status: 'EXPIRED' });
      addOutbox(items);
      resetConversation(o.customerPhone);
      return { changed: true };
    },
    async flagPaymentAnomaly(chargeId, anomaly) {
      const p = [...payments.values()].find((x) => x.chargeId === chargeId);
      if (p) p.anomaly = anomaly;
    },
    async enqueueOutbox(items) { addOutbox(items); },

    async claimOutbox({ limit, now, staleLockMs }) {
      const stale = now.getTime() - staleLockMs;
      const due = outbox
        .filter((r) => (r.status === 'PENDING' && r.nextAttemptAt <= now) || (r.status === 'SENDING' && r.lockedAt.getTime() < stale))
        .slice(0, limit);
      due.forEach((r) => { r.status = 'SENDING'; r.lockedAt = now; r.attempts += 1; });
      return due.map((r) => structuredClone(r));
    },
    async markOutboxSent(id) { Object.assign(outbox.find((r) => r.id === id), { status: 'SENT', sentAt: new Date(), lockedAt: null }); },
    async markOutboxRetry(id, error, nextAttemptAt) { Object.assign(outbox.find((r) => r.id === id), { status: 'PENDING', nextAttemptAt, lockedAt: null, lastError: error }); },
    async markOutboxFailed(id, error) { Object.assign(outbox.find((r) => r.id === id), { status: 'FAILED', lockedAt: null, lastError: error }); },

    // Auxiliares só para testes
    _outbox: () => outbox.map((r) => structuredClone(r)),
    _orders: () => [...orders.values()].map(view),
  };
}
