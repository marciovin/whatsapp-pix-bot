import { HttpError } from '../utils/errors.js';

export const notFound = (_req, res) => res.status(404).json({ error: 'não encontrado' });

export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'corpo inválido' });
    // Banco indisponível (Prisma P1001/P1002/P1017 ou erro de inicialização)
    if (['P1001', 'P1002', 'P1017'].includes(err.code) || err.name === 'PrismaClientInitializationError') {
      logger.error({ err: err.message }, 'banco de dados indisponível');
      return res.status(503).json({ error: 'serviço temporariamente indisponível' });
    }
    logger.error({ err: err.message, path: req.path }, 'erro não tratado');
    return res.status(500).json({ error: 'erro interno' });
  };
}
