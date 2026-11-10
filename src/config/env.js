import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  DATABASE_URL: z.string().min(1),

  STORE_NAME: z.string().min(1).default('Minha Loja'),
  OWNER_WHATSAPP_NUMBER: z.string().regex(/^\d{10,15}$/, 'Use apenas dígitos com DDI, ex.: 5524999999999'),

  WHATSAPP_ACCESS_TOKEN: z.string().min(10),
  WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d+$/),
  WHATSAPP_VERIFY_TOKEN: z.string().min(16),
  WHATSAPP_APP_SECRET: z.string().min(10),
  WHATSAPP_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v21.0'),
  OWNER_NOTIFY_TEMPLATE: z.string().optional().transform((v) => (v ? v : undefined)),
  OWNER_NOTIFY_TEMPLATE_LANG: z.string().default('pt_BR'),

  ASAAS_API_KEY: z.string().min(10),
  ASAAS_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  ASAAS_WEBHOOK_TOKEN: z.string().min(32, 'Use um token aleatório com pelo menos 32 caracteres'),

  OUTBOX_POLL_MS: z.coerce.number().int().min(500).default(5000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
});

export function loadConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida (.env):\n${issues}`);
  }
  const config = result.data;
  if (config.NODE_ENV === 'production' && config.ASAAS_ENV !== 'production') {
    config.warnings = ['NODE_ENV=production com ASAAS_ENV=sandbox: nenhum pagamento real será processado.'];
  }
  return config;
}
