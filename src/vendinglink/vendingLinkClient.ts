import axios from 'axios';
import { env } from '../config/env';
import { appendLog } from '../services/transactionService';

export class VendingLinkDeliveryError extends Error {
  constructor(message: string, public isRetryable: boolean) {
    super(message);
    this.name = 'VendingLinkDeliveryError';
  }
}

export const deliverToVendingLink = async (
  transactionId: string,
  supplierCode: string,
  supplierProductId: string,
  vlProductId: string,
  qty: number,
  items: string[]
) => {
  const payload = {
    transaction_id: transactionId,
    product_id: vlProductId,
    supplier_code: supplierCode,
    supplier_product_id: supplierProductId,
    added_qty: qty,
    items,
    source: 'BRIDGE_BOT',
  };

  const start = Date.now();
  // We don't log items (secrets) in the DB
  const logPayload = { ...payload, items: '[REDACTED]' };
  await appendLog(transactionId, 'VENDING_REQ', logPayload);

  try {
    const { data, status } = await axios.post(
      `${env.VENDINGLINK_URL}/api/bridge/webhook/stock/topup`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.BRIDGE_SECRET_KEY}`,
          'Idempotency-Key': transactionId,
        },
        timeout: 10000, // 10s
      }
    );

    const duration = Date.now() - start;
    await appendLog(transactionId, 'VENDING_RES', data, status, duration);
    return data;
  } catch (err: any) {
    const duration = Date.now() - start;
    const status = err.response?.status;
    const resData = err.response?.data;

    await appendLog(transactionId, 'VENDING_RES', resData || { error: err.message }, status, duration);

    // 409 Conflict typically means "Already processed this idempotency key", which is a success from our perspective
    if (status === 409) return resData;

    // Retry on 5xx, 429, or network errors
    if (!status || status >= 500 || status === 429) {
      throw new VendingLinkDeliveryError(`Retryable error: ${err.message}`, true);
    }

    // 400, 401, 403, 404, etc.
    throw new VendingLinkDeliveryError(`Non-retryable VendingLink rejection (${status}): ${JSON.stringify(resData)}`, false);
  }
};
