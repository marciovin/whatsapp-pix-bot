import { createHmac } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { APP_SECRET, VERIFY_TOKEN, WEBHOOK_TOKEN, makeCtx, placeOrder } from './helpers.js';

const sign = (raw) => `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
const waBody = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '5524977776666', profile: { name: 'João' } }],
    messages: [{ id: 'wamid.HTTP1', from: '5524977776666', type: 'text', text: { body: 'oi' } }],
  } }] }],
});

describe('endpoints HTTP', () => {
  it('GET /webhooks/whatsapp: verificação do webhook da Meta', async () => {
    const app = createApp(makeCtx());
    const ok = await request(app).get('/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '12345' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('12345');
    const bad = await request(app).get('/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '1' });
    expect(bad.status).toBe(403);
  });

  it('POST /webhooks/whatsapp rejeita assinatura ausente ou inválida', async () => {
    const ctx = makeCtx();
    const spy = vi.spyOn(ctx.conversation, 'handleMessage');
    const app = createApp(ctx);
    expect((await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').send(waBody)).status).toBe(401);
    expect((await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', 'sha256=deadbeef').send(waBody)).status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('POST /webhooks/whatsapp com assinatura válida processa a mensagem', async () => {
    const ctx = makeCtx();
    const app = createApp(ctx);
    const res = await request(app).post('/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(waBody)).send(waBody);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(ctx.wa.to('5524977776666').length).toBeGreaterThan(0));
  });

  it('POST /webhooks/asaas exige o token e confirma o pagamento', async () => {
    const ctx = makeCtx();
    const order = await placeOrder(ctx);
    const chargeId = order.payment.chargeId;
    ctx.asaas.setStatus(chargeId, 'RECEIVED');
    const app = createApp(ctx);
    const body = { id: 'evt_http', event: 'PAYMENT_RECEIVED', payment: { id: chargeId } };
    expect((await request(app).post('/webhooks/asaas').send(body)).status).toBe(401);
    expect((await request(app).post('/webhooks/asaas').set('asaas-access-token', 'errado').send(body)).status).toBe(401);
    const ok = await request(app).post('/webhooks/asaas').set('asaas-access-token', WEBHOOK_TOKEN).send(body);
    expect(ok.status).toBe(200);
    expect(ok.body.result).toBe('CONFIRMED');
  });

  it('health e readiness; readiness devolve 503 se o banco cair', async () => {
    const ctx = makeCtx();
    const app = createApp(ctx);
    expect((await request(app).get('/health')).status).toBe(200);
    expect((await request(app).get('/ready')).status).toBe(200);
    ctx.store.ping = async () => { throw new Error('db down'); };
    expect((await request(app).get('/ready')).status).toBe(503);
  });
});
