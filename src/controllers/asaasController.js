import { asyncHandler } from '../utils/asyncHandler.js';

export function createAsaasController({ payments }) {
  return {
    receive: asyncHandler(async (req, res) => {
      const outcome = await payments.handleWebhook({ token: req.get('asaas-access-token'), body: req.body });
      res.status(200).json({ received: true, result: outcome.result });
    }),
  };
}
