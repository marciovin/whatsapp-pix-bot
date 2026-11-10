import { describe, expect, it } from 'vitest';
import { createContainer } from '../src/container.js';
import { createStaticCatalogProvider } from '../src/config/catalog.js';
import { CUSTOMER, chat, makeCtx, paidWebhook, placeOrder, silentLogger } from './helpers.js';

const state = async (ctx) => (await ctx.store.getConversation(CUSTOMER)).state;
const last = (ctx) => ctx.wa.to(CUSTOMER).filter((m) => m.kind === 'text').at(-1).body;

describe('máquina de estados da conversa', () => {
  it('percorre IDLE → MENU → ADDRESS → ASK_CPF → CONFIRM → AWAITING_PAYMENT', async () => {
    const ctx = makeCtx();
    expect(await state(ctx)).toBe('IDLE');
    await chat(ctx, 'oi'); expect(await state(ctx)).toBe('MENU');
    await chat(ctx, '1x2'); expect(await state(ctx)).toBe('MENU');
    await chat(ctx, 'finalizar'); expect(await state(ctx)).toBe('ADDRESS');
    await chat(ctx, 'Rua das Flores, 123, Centro'); expect(await state(ctx)).toBe('ASK_CPF');
    await chat(ctx, '52998224725'); expect(await state(ctx)).toBe('CONFIRM');
    await chat(ctx, 'sim'); expect(await state(ctx)).toBe('AWAITING_PAYMENT');
  });

  it('trata mensagens inesperadas sem travar', async () => {
    const ctx = makeCtx();
    await chat(ctx, 'oi');
    await chat(ctx, 'asdfghjkl');
    expect(await state(ctx)).toBe('MENU');
    expect(last(ctx)).toContain('Não entendi');
    await chat(ctx, 'finalizar'); // carrinho vazio
    expect(await state(ctx)).toBe('MENU');
    await ctx.conversation.handleMessage({ id: 'wamid.img', from: CUSTOMER, name: null, type: 'image', text: null });
    expect(last(ctx)).toContain('mensagens de texto');
  });

  it('rejeita endereço curto e CPF inválido', async () => {
    const ctx = makeCtx();
    await chat(ctx, 'oi'); await chat(ctx, '1'); await chat(ctx, 'finalizar');
    await chat(ctx, 'rua x'); expect(await state(ctx)).toBe('ADDRESS');
    await chat(ctx, 'Rua das Flores, 123, Centro'); await chat(ctx, '12345678900');
    expect(await state(ctx)).toBe('ASK_CPF');
  });

  it('permite reiniciar o atendimento', async () => {
    const ctx = makeCtx();
    await chat(ctx, 'oi'); await chat(ctx, '1x3');
    await chat(ctx, 'reiniciar');
    await chat(ctx, 'carrinho');
    expect(last(ctx)).toContain('vazio');
  });

  it('preserva o estado quando o servidor reinicia (novo container, mesmo banco)', async () => {
    const ctx = makeCtx();
    await chat(ctx, 'oi'); await chat(ctx, '1x2'); await chat(ctx, 'finalizar');
    const restarted = createContainer({ ...ctx, config: ctx.config, store: ctx.store, wa: ctx.wa, asaas: ctx.asaas, catalogProvider: createStaticCatalogProvider(), logger: silentLogger });
    await chat(restarted, 'Rua das Flores, 123, Centro');
    expect(await state(restarted)).toBe('ASK_CPF');
  });

  it('não cria pedidos duplicados quando a Meta reenvia o mesmo evento', async () => {
    const ctx = makeCtx();
    await chat(ctx, 'oi'); await chat(ctx, '1'); await chat(ctx, 'finalizar');
    await chat(ctx, 'Rua das Flores, 123, Centro'); await chat(ctx, '52998224725');
    const msg = { id: 'wamid.SAME', from: CUSTOMER, name: 'Maria', type: 'text', text: 'sim' };
    const [a, b] = await Promise.all([ctx.conversation.handleMessage(msg), ctx.conversation.handleMessage(msg)]);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(ctx.store._orders()).toHaveLength(1);
  });
});

describe('cancelamento', () => {
  it('cancela pedido ainda não pago e cancela a cobrança no provedor', async () => {
    const ctx = makeCtx();
    const order = await placeOrder(ctx);
    await chat(ctx, 'cancelar');
    expect(ctx.store._orders()[0].status).toBe('CANCELED');
    expect(ctx.asaas.charges.get(order.payment.chargeId).status).toBe('DELETED');
    expect(await state(ctx)).toBe('IDLE');
    expect(ctx.store._outbox().filter((o) => o.kind === 'OWNER_ORDER_SUMMARY')).toHaveLength(0);
  });

  it('não cancela pedido que já foi pago (consulta o provedor antes)', async () => {
    const ctx = makeCtx();
    const order = await placeOrder(ctx);
    ctx.asaas.setStatus(order.payment.chargeId, 'RECEIVED'); // cliente pagou, webhook ainda não chegou
    await chat(ctx, 'cancelar');
    expect(ctx.store._orders()[0].status).toBe('PAID');
    expect(last(ctx)).toContain('já foi pago');
  });

  it('"paguei" não confirma nada sem confirmação do provedor', async () => {
    const ctx = makeCtx();
    await placeOrder(ctx);
    await chat(ctx, 'paguei, olha o comprovante');
    expect(ctx.store._orders()[0].status).toBe('AWAITING_PAYMENT');
    expect(last(ctx)).toContain('Ainda não identificamos');
  });

  it('"status" confirma se o provedor já registrou o pagamento', async () => {
    const ctx = makeCtx();
    const order = await placeOrder(ctx);
    ctx.asaas.setStatus(order.payment.chargeId, 'RECEIVED');
    await chat(ctx, 'status');
    expect(ctx.store._orders()[0].status).toBe('PAID');
  });
});

describe('integração webhook ↔ conversa', () => {
  it('após o pagamento a conversa volta a IDLE', async () => {
    const ctx = makeCtx();
    const order = await placeOrder(ctx);
    ctx.asaas.setStatus(order.payment.chargeId, 'RECEIVED');
    await ctx.payments.handleWebhook(paidWebhook(order.payment.chargeId));
    expect(await state(ctx)).toBe('IDLE');
  });
});
