import { maskPhone } from '../utils/security.js';

const BASE_DELAY_MS = 15_000;
const MAX_DELAY_MS = 30 * 60_000;
const STALE_LOCK_MS = 2 * 60_000;

export const backoffMs = (attempts) => Math.min(BASE_DELAY_MS * 2 ** (attempts - 1), MAX_DELAY_MS);

export function createOutboxWorker({ store, wa, config, logger }) {
  let timer = null;
  let running = false;

  async function deliver(row) {
    const { payload } = row;
    if (payload.template) return wa.sendTemplate(row.to, payload.template);
    return wa.sendText(row.to, payload.text);
  }

  /** Processa mensagens vencidas. `now` é injetável para testes. */
  async function tick(now = new Date()) {
    const rows = await store.claimOutbox({ limit: 10, now, staleLockMs: STALE_LOCK_MS });
    for (const row of rows) {
      try {
        await deliver(row);
        await store.markOutboxSent(row.id);
      } catch (err) {
        const retryable = err.retryable !== false;
        const exhausted = row.attempts >= config.OUTBOX_MAX_ATTEMPTS;
        if (!retryable || exhausted) {
          await store.markOutboxFailed(row.id, err.message);
          logger.error({ outboxId: row.id, kind: row.kind, to: maskPhone(row.to), attempts: row.attempts, err: err.message }, 'envio do outbox falhou definitivamente');
        } else {
          const next = new Date(now.getTime() + backoffMs(row.attempts));
          await store.markOutboxRetry(row.id, err.message, next);
          logger.warn({ outboxId: row.id, kind: row.kind, attempts: row.attempts, nextAttemptAt: next }, 'envio do outbox falhou; nova tentativa agendada');
        }
      }
    }
    return rows.length;
  }

  return {
    tick,
    start() {
      timer = setInterval(async () => {
        if (running) return;
        running = true;
        try { await tick(); } catch (err) { logger.error({ err: err.message }, 'erro no worker do outbox'); } finally { running = false; }
      }, config.OUTBOX_POLL_MS);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); },
  };
}
