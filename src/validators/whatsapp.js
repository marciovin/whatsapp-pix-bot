import { z } from 'zod';

const messageSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().regex(/^\d{8,16}$/),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
  })
  .passthrough();

const payloadSchema = z.object({
  object: z.string(),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z
                .object({
                  messages: z.array(z.unknown()).optional(),
                  contacts: z
                    .array(z.object({ wa_id: z.string().optional(), profile: z.object({ name: z.string().optional() }).optional() }).passthrough())
                    .optional(),
                })
                .passthrough(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

/** Extrai mensagens recebidas (ignora eventos de status de entrega). */
export function extractMessages(body) {
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success || parsed.data.object !== 'whatsapp_business_account') return [];
  const out = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      const contacts = change.value.contacts ?? [];
      for (const raw of change.value.messages ?? []) {
        const m = messageSchema.safeParse(raw);
        if (!m.success) continue;
        const contact = contacts.find((c) => c.wa_id === m.data.from);
        out.push({
          id: m.data.id,
          from: m.data.from,
          name: contact?.profile?.name?.slice(0, 60) ?? null,
          type: m.data.type,
          text: m.data.text?.body?.slice(0, 1000) ?? null,
        });
      }
    }
  }
  return out;
}
