/** Valida CPF (apenas dígitos verificadores; não consulta a Receita). */
export function isValidCpf(input) {
  const cpf = String(input ?? '').replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += Number(cpf[i]) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

export const onlyDigits = (s) => String(s ?? '').replace(/\D/g, '');
