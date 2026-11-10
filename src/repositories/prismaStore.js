const isUniqueViolation = (err) => err?.code === 'P2002';

/**
 * Implementação PostgreSQL (Prisma) do "store". Todas as transições críticas
 * (confirmar/expirar/cancelar) usam UPDATE condicional dentro de transação:
 * só UMA chamada concorrente consegue mudar o status de AWAITING_PAYMENT.
 */
export function createPrismaStore(prisma) {
  const resetConversation = (tx, phone) =>
    tx.conversation.updateMany({ where: { phone }, data: { state: 'IDLE', context: {} } });

  return {
    async ping() { await prisma.$queryRaw`SELECT 1`; },

    async claimInboundMessage(waMessageId) {
      try {
        await prisma.inboundMessage.create({ data: { waMessageId } });
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },
    async releaseInboundMessage(waMessageId) { await prisma.inboundMessage.deleteMany({ where: { waMessageId } }); },

    getConversation: (phone) => prisma.conversation.upsert({ where: { phone }, create: { phone }, update: {} }),
    async saveConversation(phone, { state, context }) {
      await prisma.conversation.upsert({ where: { phone }, create: { phone, state, context }, update: { state, context } });
    },

    createOrder: ({ customerPhone, customerName, address, items, totalCents }) =>
      prisma.order.create({ data: { customerPhone, customerName, address, items, totalCents } }),
    async attachCharge(orderId, { chargeId, amountCents, pixPayload, expiresAt }) {
      await prisma.payment.create({ data: { orderId, chargeId, amountCents, pixPayload, pixExpiresAt: expiresAt ?? null } });
    },
    getOrder: (id) => prisma.order.findUnique({ where: { id }, include: { payment: true } }),
    getOrderByChargeId: (chargeId) => prisma.order.findFirst({ where: { payment: { chargeId } }, include: { payment: true } }),

    async cancelOrder(orderId) {
      return prisma.$transaction(async (tx) => {
        const r = await tx.order.updateMany({ where: { id: orderId, status: 'AWAITING_PAYMENT' }, data: { status: 'CANCELED' } });
        if (r.count === 0) return false;
        await tx.payment.updateMany({ where: { orderId }, data: { status: 'CANCELED' } });
        return true;
      });
    },

    async recordPaymentEvent({ eventId, event, chargeId }) {
      try {
        await prisma.paymentEvent.create({ data: { eventId, event, chargeId } });
        return { created: true, status: 'RECEIVED' };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const existing = await prisma.paymentEvent.findUnique({ where: { eventId } });
        return { created: false, status: existing?.status ?? 'RECEIVED' };
      }
    },
    async markPaymentEvent(eventId, status, note) {
      await prisma.paymentEvent.update({
        where: { eventId },
        data: { status, note, processedAt: status === 'PROCESSED' ? new Date() : null },
      });
    },

    async confirmPayment({ orderId, chargeId, outbox }) {
      return prisma.$transaction(async (tx) => {
        const now = new Date();
        const r = await tx.order.updateMany({ where: { id: orderId, status: 'AWAITING_PAYMENT' }, data: { status: 'PAID', paidAt: now } });
        if (r.count === 0) return { changed: false };
        await tx.payment.update({ where: { chargeId }, data: { status: 'PAID', paidAt: now } });
        await tx.outbox.createMany({ data: outbox, skipDuplicates: true });
        const order = await tx.order.findUnique({ where: { id: orderId } });
        await resetConversation(tx, order.customerPhone);
        return { changed: true };
      });
    },

    async expireOrder({ orderId, chargeId, outbox }) {
      return prisma.$transaction(async (tx) => {
        const r = await tx.order.updateMany({ where: { id: orderId, status: 'AWAITING_PAYMENT' }, data: { status: 'EXPIRED' } });
        if (r.count === 0) return { changed: false };
        await tx.payment.update({ where: { chargeId }, data: { status: 'EXPIRED' } });
        await tx.outbox.createMany({ data: outbox, skipDuplicates: true });
        const order = await tx.order.findUnique({ where: { id: orderId } });
        await resetConversation(tx, order.customerPhone);
        return { changed: true };
      });
    },

    async flagPaymentAnomaly(chargeId, anomaly) { await prisma.payment.updateMany({ where: { chargeId }, data: { anomaly } }); },
    async enqueueOutbox(items) { await prisma.outbox.createMany({ data: items, skipDuplicates: true }); },

    /** Reivindica linhas vencidas com UPDATE condicional (seguro com várias instâncias). */
    async claimOutbox({ limit, now, staleLockMs }) {
      const stale = new Date(now.getTime() - staleLockMs);
      const candidates = await prisma.outbox.findMany({
        where: { OR: [{ status: 'PENDING', nextAttemptAt: { lte: now } }, { status: 'SENDING', lockedAt: { lt: stale } }] },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
      const claimed = [];
      for (const row of candidates) {
        const r = await prisma.outbox.updateMany({
          where: { id: row.id, status: row.status, ...(row.status === 'SENDING' ? { lockedAt: row.lockedAt } : {}) },
          data: { status: 'SENDING', lockedAt: now, attempts: { increment: 1 } },
        });
        if (r.count === 1) claimed.push({ ...row, attempts: row.attempts + 1 });
      }
      return claimed;
    },
    async markOutboxSent(id) { await prisma.outbox.update({ where: { id }, data: { status: 'SENT', sentAt: new Date(), lockedAt: null, lastError: null } }); },
    async markOutboxRetry(id, error, nextAttemptAt) {
      await prisma.outbox.update({ where: { id }, data: { status: 'PENDING', nextAttemptAt, lockedAt: null, lastError: String(error).slice(0, 300) } });
    },
    async markOutboxFailed(id, error) {
      await prisma.outbox.update({ where: { id }, data: { status: 'FAILED', lockedAt: null, lastError: String(error).slice(0, 300) } });
    },
  };
}
