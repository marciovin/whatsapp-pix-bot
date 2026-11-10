import { describe, expect, it } from 'vitest';
import { createStaticCatalogProvider } from '../src/config/catalog.js';
import { addToCart, parseSelection, priceCart } from '../src/services/orderService.js';
import { isValidCpf } from '../src/utils/cpf.js';
import { chat, makeCtx, placeOrder } from './helpers.js';

const catalog = await createStaticCatalogProvider().getCatalog();

describe('cálculo de valores (servidor)', () => {
  it('calcula itens e total a partir do catálogo', () => {
    const { items, totalCents } = priceCart({ 'exemplo-a': 2, 'exemplo-b': 1 }, catalog);
    expect(items).toHaveLength(2);
    expect(totalCents).toBe(2 * 1000 + 2550);
  });

  it('ignora produtos inexistentes no carrinho (preço nunca vem do cliente)', () => {
    expect(priceCart({ 'produto-fantasma': 5 }, catalog).totalCents).toBe(0);
  });

  it('interpreta seleções válidas e rejeita inválidas', () => {
    expect(parseSelection('1x2, 3', catalog).picks).toEqual([
      { productId: 'exemplo-a', qty: 2 },
      { productId: 'exemplo-c', qty: 1 },
    ]);
    expect(parseSelection('9', catalog).error).toBe('ITEM');
    expect(parseSelection('1x999', catalog).error).toBe('QTY');
    expect(parseSelection('quero pizza', catalog).error).toBe('FORMAT');
  });

  it('limita a quantidade acumulada por item', () => {
    expect(addToCart({ 'exemplo-a': 19 }, [{ productId: 'exemplo-a', qty: 2 }]).error).toBe('QTY');
  });

  it('valida CPF', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('11111111111')).toBe(false);
    expect(isValidCpf('52998224720')).toBe(false);
  });
});

describe('criação de pedidos', () => {
  it('cria pedido com id único, valor calculado no servidor e cobrança associada', async () => {
    const ctx = makeCtx();
    const a = await placeOrder(ctx, '5524911110001');
    const b = await placeOrder(ctx, '5524911110002');
    expect(a.id).not.toBe(b.id);
    expect(a.orderNumber).not.toBe(b.orderNumber);
    expect(a.totalCents).toBe(4550);
    expect(a.payment.chargeId).toMatch(/^pay_test_/);
    expect(a.payment.amountCents).toBe(4550);
    expect(ctx.asaas.charges.get(a.payment.chargeId).externalReference).toBe(a.id);
  });

  it('envia o código PIX copia e cola e o QR Code ao cliente', async () => {
    const ctx = makeCtx();
    const order = await placeOrder(ctx);
    const texts = ctx.wa.to('5524988887777').filter((m) => m.kind === 'text').map((m) => m.body);
    expect(texts).toContain(order.payment.pixPayload);
    expect(ctx.wa.sent.some((m) => m.kind === 'image')).toBe(true);
  });

  it('não persiste o CPF depois de gerar a cobrança', async () => {
    const ctx = makeCtx();
    await placeOrder(ctx);
    const conv = await ctx.store.getConversation('5524988887777');
    expect(JSON.stringify(conv)).not.toContain('52998224725');
  });

  it('se o provedor falhar, o pedido é cancelado e o cliente pode tentar de novo', async () => {
    const ctx = makeCtx();
    ctx.asaas.createPixCharge = async () => { throw new Error('asaas fora do ar'); };
    await chat(ctx, 'oi'); await chat(ctx, '1'); await chat(ctx, 'finalizar');
    await chat(ctx, 'Rua das Flores, 123, Centro'); await chat(ctx, '52998224725'); await chat(ctx, 'sim');
    expect(ctx.store._orders()[0].status).toBe('CANCELED');
    expect((await ctx.store.getConversation('5524988887777')).state).toBe('CONFIRM');
  });
});
