import axios, { AxiosInstance } from 'axios';
import { env } from '../../config/env';
import { Product, PurchaseParams, PurchaseResult } from '../types';
import {
  ISupplierAdapter,
  SupplierRejectedError,
  SupplierFailedRefundedError,
  SupplierUnknownOutcomeError,
} from '../ISupplierAdapter';
import { appendLog } from '../../services/transactionService';

export class RezekiShopAdapter implements ISupplierAdapter {
  code = 'RZK';
  displayName = 'Rezeki Shop';
  private client: AxiosInstance;

  constructor() {
    if (!env.SUPPLIER_RZK_BASE_URL || !env.SUPPLIER_RZK_API_KEY) {
      throw new Error('Rezeki Shop credentials not configured');
    }
    this.client = axios.create({
      baseURL: env.SUPPLIER_RZK_BASE_URL,
      headers: {
        'X-API-Key': env.SUPPLIER_RZK_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 10000, // 10s default for reads
    });
  }

  async getProductList(search?: string): Promise<Product[]> {
    try {
      const { data } = await this.client.get('/v1/products', {
        params: { search, lang: 'id' },
      });
      const rawProducts = Array.isArray(data)
        ? data
        : (data.products || data.data || []);

      return rawProducts.map((p: any) => ({
        id: p.id,
        name: p.name,
        price: p.price_idr ?? p.price ?? 0,
        availability: p.availability,
        requiresEmail: p.requires_email || false,
        description: p.description || '',
      }));
    } catch (err: any) {
      throw new Error(`RezekiShop getProductList failed: ${err.message}`);
    }
  }

  async getProduct(id: string): Promise<Product | null> {
    try {
      const { data } = await this.client.get(`/v1/products/${id}`, {
        params: { lang: 'id' },
      });
      const p = data.product || data.data || data;
      return {
        id: p.id,
        name: p.name,
        price: p.price_idr ?? p.price ?? 0,
        stock: p.stock,
        availability: p.availability,
        requiresEmail: p.requires_email || false,
        description: p.description || '',
      };
    } catch (err: any) {
      if (err.response?.status === 404) return null;
      throw new Error(`RezekiShop getProduct failed: ${err.message}`);
    }
  }

  async purchaseProduct(params: PurchaseParams): Promise<PurchaseResult> {
    const start = Date.now();
    const payload: any = {
      product_id: params.productId,
      quantity: params.qty,
    };

    if (params.emails && params.emails.length > 0) {
      if (params.qty === 1) {
        payload.email = params.emails[0];
      } else {
        payload.emails = params.emails;
      }
    }

    await appendLog(params.transactionId, 'SUPPLIER_REQ', payload);

    try {
      const { data } = await this.client.post('/v1/order', payload, {
        timeout: 30000, // 30s timeout for purchases
      });
      const duration = Date.now() - start;
      await appendLog(params.transactionId, 'SUPPLIER_RES', data, 200, duration);

      let deliveredKeys = data.delivered_keys || (data.delivered_key ? [data.delivered_key] : []);
      if (deliveredKeys.length === 0) {
        deliveredKeys = ["HUBUNGI_ADMIN:DIRECT_TOPUP_" + params.transactionId];
      }

      return {
        orderId: data.order_id?.toString() || params.transactionId,
        deliveredKeys,
        balance: {
          before: data.balance?.balance_before,
          deducted: data.balance?.balance_deducted,
          refunded: data.balance?.balance_refunded,
          after: data.balance?.balance_after,
        }
      };
    } catch (err: any) {
      const duration = Date.now() - start;
      const status = err.response?.status;
      const resData = err.response?.data;

      await appendLog(params.transactionId, 'SUPPLIER_RES', resData || { error: err.message }, status, duration);

      if (status) {
        if ([400, 401, 402, 404, 422].includes(status)) {
          throw new SupplierRejectedError(`Rejected (${status}): ${JSON.stringify(resData)}`);
        }
        if ([500, 502].includes(status)) {
          throw new SupplierFailedRefundedError(`Failed/Refunded (${status}): ${JSON.stringify(resData)}`);
        }
      }

      throw new SupplierUnknownOutcomeError(`Unknown outcome (Timeout or Network Error): ${err.message}`);
    }
  }

  async findRecentOrder(match: { productId: string; qty: number; since: Date }): Promise<PurchaseResult | null> {
    try {
      const { data } = await this.client.get('/v1/orders');
      const orders = Array.isArray(data) ? data : data.data || [];

      // Look for an order created after 'since' matching productId and qty
      const found = orders.find((o: any) => {
        const created = new Date(o.created_at || o.date);
        return created >= match.since && o.product_id === match.productId && o.quantity === match.qty;
      });

      if (!found) return null;

      // Ensure we get the full details (keys)
      const detailRes = await this.client.get(`/v1/order/${found.id || found.order_id}`);
      const detail = detailRes.data.data || detailRes.data;

      return {
        orderId: detail.id?.toString(),
        deliveredKeys: detail.delivered_keys || (detail.delivered_key ? [detail.delivered_key] : []),
        balance: {} // historical order might not include balance diff
      };
    } catch (err: any) {
      throw new Error(`findRecentOrder failed: ${err.message}`);
    }
  }

  async getBalance(): Promise<number> {
    try {
      const { data } = await this.client.get('/v1/balance');
      const bal = data.data || data;
      return bal.balance || 0;
    } catch (err: any) {
      throw new Error(`getBalance failed: ${err.message}`);
    }
  }
}
