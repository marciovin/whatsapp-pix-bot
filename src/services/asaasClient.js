import { AsaasError } from '../utils/errors.js';
import { centsToReais, reaisToCents } from '../utils/money.js';

const BASE_URLS = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3',
};

const todayInSaoPaulo = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()); // YYYY-MM-DD

export function createAsaasClient({ apiKey, env, fetchImpl = fetch }) {
  const base = BASE_URLS[env];

  async function request(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', access_token: apiKey, 'User-Agent': 'whatsapp-pix-bot' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new AsaasError(`Falha de rede ao chamar o Asaas: ${err.message}`, { retryable: true });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.errors?.map((e) => e.description).join('; ') || `HTTP ${res.status}`;
      throw new AsaasError(detail, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
    }
    return data;
  }

  async function findOrCreateCustomer({ name, cpfCnpj, mobilePhone }) {
    const found = await request('GET', `/customers?cpfCnpj=${encodeURIComponent(cpfCnpj)}&limit=1`);
    if (found?.data?.length) return found.data[0];
    return request('POST', '/customers', { name, cpfCnpj, mobilePhone, notificationDisabled: true });
  }

  return {
    /** Cria a cobrança PIX e busca o copia-e-cola/QR Code. */
    async createPixCharge({ customerName, cpfCnpj, mobilePhone, valueCents, externalReference, description }) {
      const customer = await findOrCreateCustomer({ name: customerName, cpfCnpj, mobilePhone });
      const payment = await request('POST', '/payments', {
        customer: customer.id,
        billingType: 'PIX',
        value: centsToReais(valueCents),
        dueDate: todayInSaoPaulo(),
        description,
        externalReference,
      });
      const qr = await request('GET', `/payments/${payment.id}/pixQrCode`);
      return {
        chargeId: payment.id,
        pixPayload: qr.payload,
        qrImageBase64: qr.encodedImage ?? null,
        expiresAt: qr.expirationDate ? new Date(qr.expirationDate.replace(' ', 'T')) : null,
      };
    },

    /** Estado real da cobrança no Asaas (fonte da verdade para confirmar pagamento). */
    async getPayment(chargeId) {
      const p = await request('GET', `/payments/${encodeURIComponent(chargeId)}`);
      return {
        id: p.id,
        status: p.status,
        valueCents: reaisToCents(p.value),
        externalReference: p.externalReference ?? null,
        billingType: p.billingType,
      };
    },

    async cancelCharge(chargeId) {
      return request('DELETE', `/payments/${encodeURIComponent(chargeId)}`);
    },
  };
}
