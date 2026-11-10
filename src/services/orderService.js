export const MAX_QTY = 20;

/** Interpreta "1", "1x2", "1 x 2, 3" → [{productId, qty}]. Nunca aceita preços do cliente. */
export function parseSelection(text, catalog) {
  const parts = text.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { error: 'FORMAT' };
  const picks = [];
  for (const part of parts) {
    const m = part.match(/^(\d{1,3})(?:\s*[x×*]\s*(\d{1,3}))?$/i);
    if (!m) return { error: 'FORMAT' };
    const index = Number(m[1]);
    const qty = m[2] ? Number(m[2]) : 1;
    if (index < 1 || index > catalog.length) return { error: 'ITEM' };
    if (qty < 1 || qty > MAX_QTY) return { error: 'QTY' };
    picks.push({ productId: catalog[index - 1].id, qty });
  }
  return { picks };
}

export function addToCart(cart, picks) {
  const next = { ...cart };
  for (const { productId, qty } of picks) {
    next[productId] = (next[productId] ?? 0) + qty;
    if (next[productId] > MAX_QTY) return { error: 'QTY' };
  }
  return { cart: next };
}

/** Calcula itens e total NO SERVIDOR a partir do catálogo (fonte única de preços). */
export function priceCart(cart, catalog) {
  const items = [];
  let totalCents = 0;
  for (const product of catalog) {
    const qty = cart?.[product.id];
    if (!qty) continue;
    const lineCents = product.priceCents * qty;
    items.push({ productId: product.id, name: product.name, unitPriceCents: product.priceCents, qty, lineCents });
    totalCents += lineCents;
  }
  return { items, totalCents };
}
