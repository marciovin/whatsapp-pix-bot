import { formatBRL } from '../utils/money.js';

const cartLines = (items) => items.map((i) => `• ${i.qty}x ${i.name} — ${formatBRL(i.lineCents)}`).join('\n');

export const greeting = (storeName, name, catalog) =>
  `Olá${name ? `, ${name}` : ''}! Bem-vindo(a) à *${storeName}*.\n\n${menu(catalog)}`;

export const menu = (catalog) =>
  `*Cardápio*\n${catalog.map((p, i) => `${i + 1} - ${p.name} — ${formatBRL(p.priceCents)}`).join('\n')}\n\n` +
  'Para pedir, envie o número do item e a quantidade. Exemplos:\n' +
  '• *1* (1 unidade do item 1)\n• *1x2* (2 unidades do item 1)\n• *1x2, 3* (vários itens de uma vez)\n\n' +
  'Comandos: *carrinho* · *limpar* · *finalizar* · *cancelar*';

export const cartSummary = (items, totalCents) =>
  items.length
    ? `*Seu carrinho*\n${cartLines(items)}\n\n*Total: ${formatBRL(totalCents)}*\n\nEnvie mais itens, ou *finalizar* para continuar.`
    : 'Seu carrinho está vazio. Envie o número de um item para começar (ou *menu* para ver o cardápio).';

export const invalidSelection = (error, catalogSize) => {
  if (error === 'ITEM') return `Não encontrei esse item. Use um número de 1 a ${catalogSize}.`;
  if (error === 'QTY') return 'Quantidade inválida. Use de 1 a 20 unidades por item.';
  return 'Não entendi 😕. Envie o número do item e a quantidade, por exemplo: *1x2*. Digite *menu* para ver as opções.';
};

export const askAddress = () =>
  'Informe o *endereço de entrega completo* (rua, número, bairro, cidade e complemento).\nDigite *voltar* para alterar o carrinho.';

export const invalidAddress = () => 'Endereço muito curto. Envie rua, número, bairro e cidade, por favor.';

export const askCpf = () =>
  'Para gerar o PIX precisamos do seu *CPF* (somente números). Ele é usado apenas para emitir a cobrança.';

export const invalidCpf = () => 'CPF inválido. Envie os 11 números do seu CPF, sem pontos ou traços.';

export const confirmOrder = (items, totalCents, address) =>
  `*Confira seu pedido*\n${cartLines(items)}\n\n*Total: ${formatBRL(totalCents)}*\n📍 ${address}\n\n` +
  'Responda *SIM* para confirmar e gerar o PIX, *NÃO* para voltar ao menu ou *CANCELAR*.';

export const pixInstructions = (order, charge) =>
  `Pedido *#${order.orderNumber}* criado! Total: *${formatBRL(order.totalCents)}*\n\n` +
  'Para pagar: abra o app do seu banco, escolha *PIX > Pix Copia e Cola* e cole o código da próxima mensagem' +
  `${charge.qrImageBase64 ? ' (ou leia o QR Code)' : ''}.\n` +
  'Assim que o pagamento for confirmado, avisamos aqui. Comandos: *pix* (reenviar código), *status*, *cancelar*.';

export const chargeFailed = () =>
  'Não consegui gerar o PIX agora 😕. Tente novamente em instantes respondendo *SIM*, ou digite *cancelar*.';

export const awaitingPayment = () =>
  'Seu pedido está aguardando o pagamento do PIX. Comandos: *pix* (reenviar código), *status* (verificar pagamento), *cancelar*.';

export const paymentNotYet = () =>
  'Ainda não identificamos o pagamento. Se você acabou de pagar, aguarde alguns instantes e envie *status* novamente.';

export const cancelled = () => 'Atendimento cancelado. Envie qualquer mensagem para começar de novo.';
export const orderCancelled = (n) => `Pedido *#${n}* cancelado. Envie qualquer mensagem para fazer um novo pedido.`;
export const cannotCancelPaid = () => 'Esse pedido já foi pago e não pode ser cancelado por aqui. Fale com a loja.';
export const finishOrCancelFirst = () => 'Você tem um pedido aguardando pagamento. Digite *cancelar* para cancelá-lo antes de recomeçar.';
export const textOnly = () => 'Por enquanto só consigo ler mensagens de texto. Digite *menu* para ver as opções.';
export const genericError = () => 'Tive um problema técnico 😕. Tente novamente em instantes.';

export const paidCustomer = (order) =>
  `✅ Pagamento confirmado! Recebemos o pedido *#${order.orderNumber}* (${formatBRL(order.totalCents)}). Obrigado!`;

export const expiredCustomer = (order) =>
  `O PIX do pedido *#${order.orderNumber}* expirou e o pedido foi encerrado. Envie qualquer mensagem para fazer um novo pedido.`;

export function ownerSummary(order, payment) {
  const lines = order.items
    .map((i) => `• ${i.qty}x ${i.name} — ${formatBRL(i.unitPriceCents)} un. = ${formatBRL(i.lineCents)}`)
    .join('\n');
  return (
    `✅ *PEDIDO PAGO #${order.orderNumber}*\n` +
    `Cliente: ${order.customerName ?? 'não informado'}\n` +
    `Telefone: +${order.customerPhone}\n` +
    `Endereço: ${order.address}\n\n` +
    `Itens:\n${lines}\n\n` +
    `*Total: ${formatBRL(order.totalCents)}*\n` +
    `Cobrança: ${payment.chargeId}\n` +
    'Pagamento: PIX confirmado'
  );
}

/** Versão em uma linha (parâmetros de template não aceitam quebras de linha). */
export function ownerSummaryOneLine(order, payment) {
  const items = order.items.map((i) => `${i.qty}x ${i.name} (${formatBRL(i.lineCents)})`).join('; ');
  return (
    `Pedido #${order.orderNumber} | Cliente: ${order.customerName ?? 'n/i'} | Tel: +${order.customerPhone} | ` +
    `Endereço: ${order.address} | Itens: ${items} | Total: ${formatBRL(order.totalCents)} | ` +
    `Cobrança: ${payment.chargeId} | PIX confirmado`
  ).replace(/\s+/g, ' ');
}

export const ownerAlert = (text) => `⚠️ *ATENÇÃO — verificação manual necessária*\n${text}`;
