import { describe, expect, it } from 'vitest';
import { backoffMs } from '../src/services/outboxWorker.js';
import { CUSTOMER, OWNER, WEBHOOK_TOKEN, makeCtx, ownerSummaries, paidWebhook, placeOrder } from './helpers.js';

async function setup(configOverrides) {
  const ctx = makeCtx(configOverrides);
  const order = await placeOrder(ctx);
  return { ctx, order, chargeId: order.payment.chargeId };
}
const orderStatus = (ctx) => ctx.store._orders()[0].status;

describe('webhook do Asaas', () => {
  it('pagamento válido: marca como pago e enfileira resumo ao responsável + aviso ao cliente', async () => {
    const { ctx, chargeId } = await setup();
    ctx.asaas.setStatus(chargeId, 'RECEIVED');
    const r = await ctx.payments.handleWebhook(paidWebhook(chargeId));
    expect(r.result).toBe('CONFIRMED');
    expect(orderStatus(ctx)).toBe('PAID');

    await ctx.outbox.tick();
    const toOwner = ctx.wa.to(OWNER);
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0].body).toContain('PEDIDO PAGO');
    expect(toOwner[0].body).toContain(chargeId);
    expect(toOwner[0].body).toContain('+5524988887777');
    expect(toOwner[0].body).toContain('Rua das Flores');
    expect(toOwner[0].body).toMatch(/2x Produto Exemplo A/);
    expect(ctx.wa.to(CUSTOMER).some((m) => m.body?.includes('Pagamento confirmado'))).toBe(true);
  });

  it('webhook inválido (token errado/ausente) é rejeitado e nada muda', async () => {
    const { ctx, chargeId } = await setup();
    ctx.asaas.setStatus(chargeId, 'RECEIVED');
    const body = paidWebhook(chargeId).body;
    await expect(ctx.payments.handleWebhook({ token: 'errado', body })).rejects.toMatchObject({ status: 401 });
    await expect(ctx.payments.handleWebhook({ token: undefined, body })).rejects.toMatchObject({ status: 401 });
    expect(orderStatus(ctx)).toBe('AWAITING_PAYMENT');
    expect(ownerSummaries(ctx)).toHaveLength(0);
  });

  it('payload malformado é rejeitado com 400', async () => {
    const { ctx } = await setup();
    await expect(ctx.payments.handleWebhook({ token: WEBHOOK_TOKEN, body: { foo: 1 } })).rejects.toMatchObject({ status: 400 });
  });

  it('webhook diz "pago" mas o Asaas ainda mostra PENDING: não confirma', async () => {
    const { ctx, chargeId } = await setup();
    const r = await ctx.payments.handleWebhook(paidWebhook(chargeId)); // status real = PENDING
    expect(r.result).toBe('NOT_PAID');
    expect(orderStatus(ctx)).toBe('AWAITING_PAYMENT');
    expect(ownerSummaries(ctx)).toHaveLength(0);
  });

  it('valor divergente: não confirma, sinaliza anomalia e alerta o responsável', async () => {
    const { ctx, chargeId } = await setup();
    ctx.asaas.patch(chargeId, { status: 'RECEIVED', valueCents: 100 });
    const r = await ctx.payments.handleWebhook(paidWebhook(chargeId));
    expect(r.result).toBe('MISMATCH_VALUE');
    expect(orderStatus(ctx)).toBe('AWAITING_PAYMENT');
    expect(ownerSummaries(ctx)).toHaveLength(0);
    expect(ctx.store._outbox().filter((o) => o.kind === 'OWNER_ALERT')).toHaveLength(1);
  });

  it('cobrança vinculada ao pedido errado: não confirma', async () => {
    const { ctx, chargeId } = await setup();
    ctx.asaas.patch(chargeId, { status: 'RECEIVED', externalReference: 'outro-pedido' });
    const r = await ctx.payments.handleWebhook(paidWebhook(chargeId));
    expect(r.result).toBe('MISMATCH_ORDER');
    expect(orderStatus(ctx)).toBe('AWAITING_PAYMENT');
    expect(ownerSummaries(ctx)).toHaveLength(0);
  });

  it('cobrança desconhecida é ignorada sem erro', async () => {
    const { ctx } = await setup();
    const r = await ctx.payments.handleWebhook(paidWebhook('pay_inexistente'));
    expect(r.result).toBe('UNKNOWN_CHARGE');
  });

  it('evento duplicado (mesmo id) não reprocessa nem duplica o resumo', async () => {
    const { ctx, chargeId } = await setup();
    ctx.asaas.setStatus(chargeId, 'RECEIVED');
    const evt = paidWebhook(chargeId, 'evt_fixo');
    expect((await ctx.payments.handleWebhook(evt)).result).toBe('CONFIRMED');
    expect((await ctx.payments.handleWebhook(evt)).result).toBe('DUPLICATE');
    expect(ownerSummaries(ctx)).toHaveLength(1);
  });

  it('eventos diferentes para a mesma cobrança (RECEIVED + CONFIRMED) geram um único resumo', async () => {
    const { ctx, chargeId } = await setup();
    ctx.asaas.setStatus(chargeId, 'RECEIVED');
    await ctx.payments.handleWebhook(paidWebhook(chargeId, 'evt_1', 'PAYMENT_RECEIVED'));
    const r = await ctx.payments.handleWebhook(paidWebhook(chargeId, 'evt_2', 'PAYMENT_CONFIRMED'));
    expect(r.result).toBe('ALREADY_PAID');
    expect(ownerSummaries(ctx)).toHaveLength(1);
  });

  it('notificações simultâneas: exatamente um resumo e uma transição de status', async () => {
    const { ctx, chargeId } = await setup();
    ctx.asaas.setStatus(chargeId, 'RECEIVED');
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => ctx.payments.handleWebhook(paidWebhook(chargeId, 'evt_mesmo'))),
      ...Array.from({ length: 5 }, (_, i) => ctx.payments.handleWebhook(paidWebhook(chargeId, `evt_${i}`))),
    ]);
    expect(results.filter((r) => r.result === 'CONFIRMED')).toHaveLength(1);
    expect(ownerSummaries(ctx)).toHaveLength(1);
    expect(ctx.store._outbox().filter((o) => o.kind === 'CUSTOMER_PAID')).toHaveLength(1);
    await ctx.outbox.tick();
    expect(ctx.wa.to(OWNER)).toHaveLength(1);
  });

  it('PIX vencido: encerra o pedido apenas se o Asaas confirmar OVERDUE', async () => {
    const { ctx, chargeId } = await setup();
    const evt = (id) => ({ token: WEBHOOK_TOKEN, body: { id, event: 'PAYMENT_OVERDUE', payment: { id: chargeId } } });
    expect((await ctx.payments.handleWebhook(evt('evt_o1'))).result).toBe('NOT_OVERDUE');
    expect(orderStatus(ctx)).toBe('AWAITING_PAYMENT');
    ctx.asaas.setStatus(chargeId, 'OVERDUE');
    expect((await ctx.payments.handleWebhook(evt('evt_o2'))).result).toBe('EXPIRED');
    expect(orderStatus(ctx)).toBe('EXPIRED');
    expect(ownerSummaries(ctx)).toHaveLength(0);
  });

  it('pagamento recebido para pedido já cancelado gera alerta manual, não resumo', async () => {
    const { ctx, chargeId } = await setup();
    await ctx.store.cancelOrder(ctx.store._orders()[0].id);
    ctx.asaas.setStatus(chargeId, 'RECEIVED');
    const r = await ctx.payments.handleWebhook(paidWebhook(chargeId));
    expect(r.result).toBe('PAID_AFTER_CANCELED');
    expect(ownerSummaries(ctx)).toHaveLength(0);
    expect(ctx.store._outbox().filter((o) => o.kind === 'OWNER_ALERT')).toHaveLength(1);
  });
});

describe('resumo ao responsável (outbox)', () => {
  it('nenhum resumo é criado nem enviado antes do pagamento confirmado', async () => {
    const { ctx } = await setup();
    await ctx.outbox.tick();
    await ctx.outbox.tick(new Date(Date.now() + 3_600_000));
    expect(ownerSummaries(ctx)).toHaveLength(0);
    expect(ctx.wa.to(OWNER)).toHaveLength(0);
  });

  it('falha temporária no envio: tenta de novo com intervalo e entrega uma única vez', async () => {
    const { ctx, chargeId } = await setup();
    ctx.asaas.setStatus(chargeId, 'RECEIVED');
    await ctx.payments.handleWebhook(paidWebhook(chargeId));
    ctx.wa.failNext(2);

    const t0 = new Date();
    await ctx.outbox.tick(t0);
    const afterFail = ownerSummaries(ctx)[0];
    expect(afterFail.status).toBe('PENDING');
    expect(afterFail.attempts).toBe(1);
    expect(afterFail.nextAttemptAt.getTime()).toBeGreaterThan(t0.getTime());

    await ctx.outbox.tick(t0); // ainda dentro do intervalo: não tenta
    expect(ownerSummaries(ctx)[0].attempts).toBe(1);

    await ctx.outbox.tick(new Date(t0.getTime() + backoffMs(1) + 1)); // falha #2 (a 1ª msg do lote)
    await ctx.outbox.tick(new Date(t0.getTime() + 3_600_000));
    await ctx.outbox.tick(new Date(t0.getTime() + 7_200_000));
    expect(ctx.wa.to(OWNER)).toHaveLength(1);
    expect(ownerSummaries(ctx)[0].status).toBe('SENT');
    await ctx.outbox.tick(new Date(t0.getTime() + 10_800_000));
    expect(ctx.wa.to(OWNER)).toHaveLength(1); // sem duplicar
  });

  it('erro permanente marca como FAILED sem repetir', async () => {
    const { ctx, chargeId } = await setup();
    ctx.asaas.setStatus(chargeId, 'RECEIVED');
    await ctx.payments.handleWebhook(paidWebhook(chargeId));
    ctx.wa.failNext(1, { retryable: false });
    await ctx.outbox.tick();
    expect(ownerSummaries(ctx)[0].status).toBe('FAILED');
  });

  it('usa template aprovado (uma linha) quando OWNER_NOTIFY_TEMPLATE está configurado', async () => {
    const { ctx, chargeId } = await setup({ OWNER_NOTIFY_TEMPLATE: 'novo_pedido_pago' });
    ctx.asaas.setStatus(chargeId, 'RECEIVED');
    await ctx.payments.handleWebhook(paidWebhook(chargeId));
    await ctx.outbox.tick();
    const msg = ctx.wa.to(OWNER)[0];
    expect(msg.kind).toBe('template');
    expect(msg.template.name).toBe('novo_pedido_pago');
    expect(msg.template.params[0]).not.toContain('\n');
  });

  it('retoma entrega de linhas presas em SENDING (processo caiu no meio)', async () => {
    const { ctx, chargeId } = await setup();
    ctx.asaas.setStatus(chargeId, 'RECEIVED');
    await ctx.payments.handleWebhook(paidWebhook(chargeId));
    await ctx.store.claimOutbox({ limit: 10, now: new Date(), staleLockMs: 120000 }); // "caiu" após reivindicar
    await ctx.outbox.tick(new Date(Date.now() + 5 * 60_000));
    expect(ctx.wa.to(OWNER)).toHaveLength(1);
  });
});
