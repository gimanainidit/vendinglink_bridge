import axios from 'axios';
import { env } from '../config/env';
import { appendLog } from '../services/transactionService';
import { logger } from '../lib/logger';

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

    // 409 Conflict handling:
    // Differentiate between COMPLETED (idempotent success) and PROCESSING (in-flight, retryable)
    if (status === 409) {
      const existingStatus = resData?.existingEvent?.status;
      if (existingStatus === 'PROCESSING') {
        throw new VendingLinkDeliveryError(
          `VendingLink event is currently PROCESSING (409 Conflict): retry later.`,
          true
        );
      }
      return resData;
    }

    // Retry on 5xx, 429, or network errors
    if (!status || status >= 500 || status === 429) {
      throw new VendingLinkDeliveryError(`Retryable error: ${err.message}`, true);
    }

    // 400, 401, 403, 404, etc.
    throw new VendingLinkDeliveryError(`Non-retryable VendingLink rejection (${status}): ${JSON.stringify(resData)}`, false);
  }
};

export interface VendingLinkProduct {
  id: string;
  name: string;
  price: number;
  type: string;
  supplierMode?: string;
  supplierProductId?: string | null;
}

export interface FetchProductsResult {
  success: boolean;
  products: VendingLinkProduct[];
  url: string;
  statusCode?: number;
  error?: string;
}

export const fetchVendingLinkProducts = async (
  search?: string,
  limit: number = 30
): Promise<FetchProductsResult> => {
  const primaryUrl = `${env.VENDINGLINK_URL}/api/bridge/products`;
  const fallbackUrl = 'https://toko.txsiber.online/api/bridge/products';

  const urlsToTry = [primaryUrl];
  if (primaryUrl !== fallbackUrl) {
    urlsToTry.push(fallbackUrl);
  }

  let lastResult: FetchProductsResult = {
    success: false,
    products: [],
    url: primaryUrl,
  };

  for (const targetUrl of urlsToTry) {
    try {
      const { data, status } = await axios.get(targetUrl, {
        params: { search, limit },
        headers: {
          Authorization: `Bearer ${env.BRIDGE_SECRET_KEY}`,
        },
        timeout: 8000,
      });

      if (data && Array.isArray(data.products)) {
        return {
          success: true,
          products: data.products,
          url: targetUrl,
          statusCode: status,
        };
      }
    } catch (err: any) {
      lastResult = {
        success: false,
        products: [],
        url: targetUrl,
        statusCode: err?.response?.status,
        error: err?.response?.data?.error || err?.message || 'Network connection failed',
      };
      logger.warn(
        { url: targetUrl, err: err?.message, status: err?.response?.status },
        'Failed to fetch products from VendingLink URL, trying next if available'
      );
    }
  }

  return lastResult;
};

export interface SyncMappingResult {
  success: boolean;
  error?: string;
  mapping?: any;
}

export const syncProductMappingToVendingLink = async (
  supplierCode: string,
  supplierProductId: string,
  vlProductId: string
): Promise<SyncMappingResult> => {
  const url = `${env.VENDINGLINK_URL}/api/bridge/mappings`;
  try {
    const { data } = await axios.post(
      url,
      {
        supplierCode,
        supplierProductId,
        productId: vlProductId,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.BRIDGE_SECRET_KEY}`,
        },
        timeout: 8000,
      }
    );
    logger.info({ supplierCode, supplierProductId, vlProductId }, 'Synced mapping to VendingLink Storefront');
    return { success: true, mapping: data?.mapping };
  } catch (err: any) {
    const errMsg = err.response?.data?.error || err.message;
    logger.error({ supplierCode, supplierProductId, vlProductId, error: errMsg }, 'Failed to sync mapping to VendingLink');
    return { success: false, error: errMsg };
  }
};

