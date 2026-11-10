import { z } from 'zod';

export const asaasWebhookSchema = z
  .object({
    id: z.string().min(1).optional(),
    event: z.string().min(1),
    payment: z.object({ id: z.string().min(1) }).passthrough(),
  })
  .passthrough();
