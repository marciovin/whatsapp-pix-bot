import { z } from 'zod';

/**
 * CATÁLOGO DE EXEMPLO — substitua pelos produtos reais do cliente.
 * - id: identificador estável, minúsculas/números/hífen (não mude depois de haver pedidos)
 * - name: nome mostrado ao cliente
 * - priceCents: preço em CENTAVOS (inteiro). R$ 10,00 = 1000
 * Itens e preços abaixo são apenas ilustrativos.
 */
const rawCatalog = [
  { id: 'exemplo-a', name: 'Produto Exemplo A', priceCents: 1000 },
  { id: 'exemplo-b', name: 'Produto Exemplo B', priceCents: 2550 },
  { id: 'exemplo-c', name: 'Serviço Exemplo C', priceCents: 5000 },
];

export const catalogSchema = z
  .array(
    z.object({
      id: z.string().regex(/^[a-z0-9-]+$/),
      name: z.string().min(1).max(80),
      priceCents: z.number().int().positive(),
    }),
  )
  .min(1)
  .refine((items) => new Set(items.map((i) => i.id)).size === items.length, 'ids duplicados no catálogo');

/**
 * Provedor de catálogo assíncrono: hoje lê a lista acima; depois pode ler de uma tabela
 * do banco (ex.: alimentada por um painel administrativo) sem mudar o resto do bot.
 */
export function createStaticCatalogProvider(items = rawCatalog) {
  const catalog = catalogSchema.parse(items);
  return { getCatalog: async () => catalog };
}
