import axios from 'axios';
import { env } from '../config/env';
import { logger } from '../lib/logger';

export interface RequestUpdatePayload {
  requestId: string;
  customerRef: string;
  status: 'FOUND' | 'NOT_FOUND' | 'REJECTED' | 'CONFIRMED' | 'PURCHASED' | 'EXPIRED';
  query: string;
  categorySlug?: string | null;
  foundSupplierCode?: string | null;
  foundProductId?: string | null;
  quotedPrice?: number | null;
  rejectionReason?: string | null;
}

export const notifyStorefrontRequestUpdate = async (payload: RequestUpdatePayload): Promise<boolean> => {
  const url = `${env.VENDINGLINK_URL}/api/bridge/webhook/request-update`;
  try {
    const { status } = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.BRIDGE_SECRET_KEY}`,
      },
      timeout: 10000,
    });
    logger.info({ requestId: payload.requestId, status }, 'Dispatched request update notification to Storefront');
    return true;
  } catch (err: any) {
    logger.error(
      {
        requestId: payload.requestId,
        error: err.message,
        status: err.response?.status,
        data: err.response?.data,
      },
      'Failed to dispatch request update notification to Storefront'
    );
    return false;
  }
};
