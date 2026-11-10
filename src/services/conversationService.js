import { isValidCpf, onlyDigits } from '../utils/cpf.js';
import { KeyedMutex } from '../utils/mutex.js';
import { maskPhone } from '../utils/security.js';
import * as messages from './messages.js';
import { addToCart, parseSelection, priceCart } from './orderService.js';

const norm = (t) => t.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const YES = new Set(['sim', 's', 'confirmar', 'confirmo']);
const NO = new Set(['nao', 'n', 'voltar']);

/**
 * Estados: IDLE → MENU → ADDRESS → ASK_CPF → CONFIRM → AWAITING_PAYMENT → (pago/cancelado/expirado → IDLE)
 */
export function createConversationService({ store, catalogProvider, payments, wa, config, logger }) {
  const mutex = new KeyedMutex();

  async function safeSend(fn, phone) {
    try {
      await fn();
    } catch (err) {
      logger.error({ to: maskPhone(phone), err: err.message }, 'falha ao enviar resposta ao cliente');
    }
  }

  async function handleMessage(msg) {
    const isNew = await store.claimInboundMessage(msg.id);
    if (!isNew) return { duplicate: true };
    try {
      await mutex.run(msg.from, () => processMessage(msg));
      return { duplicate: false };
    } catch (err) {
      logger.error({ from: maskPhone(msg.from), err: err.message }, 'erro ao processar mensagem');
      await store.releaseInboundMessage(msg.id).catch(() => {});
      await safeSend(() => wa.sendText(msg.from, messages.genericError()), msg.from);
      return { duplicate: false, error: true };
    }
  }

  async function processMessage(msg) {
    const conv = await store.getConversation(msg.from);
    let state = conv.state;
    let context = { ...(conv.context ?? {}) };
    const out = { texts: [], image: null };
    const say = (t) => out.texts.push(t);

    if (msg.type !== 'text' || !msg.text) {
      await flush(msg.from, { texts: [messages.textOnly()], image: null });
      return;
    }
    if (msg.name) context.name = msg.name;
    const text = norm(msg.text);
    const catalog = await catalogProvider.getCatalog();
    const cartView = () => priceCart(context.cart ?? {}, catalog);
    const cartText = () => { const v = cartView(); return messages.cartSummary(v.items, v.totalCents); };
    const showMenu = () => { state = 'MENU'; context = { name: context.name, cart: context.cart ?? {} }; };

    if (['reiniciar', 'recomecar'].includes(text) && state !== 'AWAITING_PAYMENT') {
      context = { name: context.name };
      showMenu();
      say(messages.greeting(config.STORE_NAME, context.name, catalog));
    } else {
      switch (state) {
        case 'MENU': {
          const { items, totalCents } = cartView();
          if (text === 'menu' || text === 'cardapio') say(messages.menu(catalog));
          else if (text === 'carrinho') say(messages.cartSummary(items, totalCents));
          else if (text === 'limpar') { context.cart = {}; say('Carrinho limpo. Envie o número de um item para começar.'); }
          else if (text === 'cancelar') { state = 'IDLE'; context = { name: context.name }; say(messages.cancelled()); }
          else if (text === 'finalizar' || text === '0') {
            if (!items.length) say(messages.cartSummary(items, totalCents));
            else { state = 'ADDRESS'; say(messages.askAddress()); }
          } else {
            const parsed = parseSelection(text, catalog);
            const added = parsed.picks ? addToCart(context.cart ?? {}, parsed.picks) : parsed;
            if (added.error) say(messages.invalidSelection(added.error, catalog.length));
            else { context.cart = added.cart; const v = cartView(); say(messages.cartSummary(v.items, v.totalCents)); }
          }
          break;
        }
        case 'ADDRESS': {
          if (text === 'voltar') { state = 'MENU'; say(cartText()); }
          else if (text === 'cancelar') { state = 'IDLE'; context = { name: context.name }; say(messages.cancelled()); }
          else if (msg.text.trim().length < 10) say(messages.invalidAddress());
          else { context.address = msg.text.trim().slice(0, 300); state = 'ASK_CPF'; say(messages.askCpf()); }
          break;
        }
        case 'ASK_CPF': {
          if (text === 'voltar') { state = 'ADDRESS'; say(messages.askAddress()); }
          else if (text === 'cancelar') { state = 'IDLE'; context = { name: context.name }; say(messages.cancelled()); }
          else if (!isValidCpf(text)) say(messages.invalidCpf());
          else {
            context.cpf = onlyDigits(text);
            state = 'CONFIRM';
            const { items, totalCents } = cartView();
            say(messages.confirmOrder(items, totalCents, context.address));
          }
          break;
        }
        case 'CONFIRM': {
          if (text === 'cancelar') { state = 'IDLE'; context = { name: context.name }; say(messages.cancelled()); }
          else if (NO.has(text)) { state = 'MENU'; delete context.cpf; say(cartText()); }
          else if (YES.has(text)) {
            const { items, totalCents } = cartView();
            if (!items.length) { state = 'MENU'; say(messages.cartSummary(items, totalCents)); break; }
            const order = await store.createOrder({
              customerPhone: msg.from, customerName: context.name ?? null, address: context.address, items, totalCents,
            });
            try {
              const charge = await payments.createCharge(order, { cpf: context.cpf });
              state = 'AWAITING_PAYMENT';
              context = { name: context.name, orderId: order.id }; // CPF e carrinho não são mais guardados
              say(messages.pixInstructions(order, charge));
              say(charge.pixPayload);
              out.image = charge.qrImageBase64;
            } catch (err) {
              logger.error({ orderId: order.id, err: err.message }, 'falha ao criar cobrança PIX');
              await store.cancelOrder(order.id);
              say(messages.chargeFailed());
            }
          } else say('Responda *SIM* para confirmar, *NÃO* para voltar ao menu ou *CANCELAR*.');
          break;
        }
        case 'AWAITING_PAYMENT': {
          const order = await store.getOrder(context.orderId);
          if (!order || order.status !== 'AWAITING_PAYMENT') { showMenu(); say(messages.greeting(config.STORE_NAME, context.name, catalog)); break; }
          if (text === 'pix') {
            say(order.payment?.pixPayload ? `Código PIX Copia e Cola do pedido #${order.orderNumber}:` : messages.awaitingPayment());
            if (order.payment?.pixPayload) say(order.payment.pixPayload);
          } else if (text === 'status' || text === 'paguei' || text.includes('paguei')) {
            const r = await payments.reconcileOrder(order.id);
            if (r.result === 'CONFIRMED' || r.result === 'ALREADY_PAID') { state = 'IDLE'; context = { name: context.name }; }
            else say(messages.paymentNotYet());
          } else if (text === 'cancelar') {
            const r = await payments.reconcileOrder(order.id); // evita cancelar algo que já foi pago
            if (r.result === 'CONFIRMED' || r.result === 'ALREADY_PAID') { state = 'IDLE'; context = { name: context.name }; say(messages.cannotCancelPaid()); }
            else if (await store.cancelOrder(order.id)) {
              if (order.payment) await payments.cancelRemoteCharge(order.payment.chargeId);
              state = 'IDLE'; context = { name: context.name };
              say(messages.orderCancelled(order.orderNumber));
            } else say(messages.cannotCancelPaid());
          } else say(['reiniciar', 'recomecar'].includes(text) ? messages.finishOrCancelFirst() : messages.awaitingPayment());
          break;
        }
        default: { // IDLE ou estado desconhecido: recomeça sem travar
          showMenu();
          say(messages.greeting(config.STORE_NAME, context.name, catalog));
        }
      }
    }

    await store.saveConversation(msg.from, { state, context });
    await flush(msg.from, out);
  }

  async function flush(phone, out) {
    for (const t of out.texts) await safeSend(() => wa.sendText(phone, t), phone);
    if (out.image) await safeSend(() => wa.sendImage(phone, { base64: out.image, caption: 'QR Code PIX' }), phone);
  }

  return { handleMessage };
}
