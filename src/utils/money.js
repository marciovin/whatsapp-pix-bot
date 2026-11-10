const fmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** Formata centavos (inteiro) como moeda brasileira. */
export const formatBRL = (cents) => fmt.format(cents / 100);

/** Converte um valor decimal em reais (como o Asaas retorna) para centavos inteiros. */
export const reaisToCents = (value) => Math.round(Number(value) * 100);

/** Converte centavos em um número decimal com 2 casas (formato enviado ao Asaas). */
export const centsToReais = (cents) => Number((cents / 100).toFixed(2));
