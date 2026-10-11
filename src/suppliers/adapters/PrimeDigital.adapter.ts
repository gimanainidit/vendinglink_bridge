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

export class PrimeDigitalAdapter implements ISupplierAdapter {
  code = 'PDA';
  displayName = 'Prime Digital AI';
  private client: AxiosInstance;

  constructor() {
    const baseURL = env.SUPPLIER_PDA_BASE_URL || 'https://prime-digital-ai.com';
    const apiKey = env.SUPPLIER_PDA_API_KEY;

    this.client = axios.create({
      baseURL,
      headers: {
        'X-API-Key': apiKey || '',
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
  }

  async getProductList(search?: string): Promise<Product[]> {
    try {
      const { data } = await this.client.get('/api/v1/products');
      const rawProducts: any[] = Array.isArray(data)
        ? data
        : (data.data || data.products || []);

      let products: Product[] = rawProducts.map((p: any) => ({
        id: p.id,
        name: p.name,
        price: p.price ?? 0,
        stock: p.stock ?? 0,
        availability: p.inStock !== false && (p.stock === undefined || p.stock > 0)
          ? 'in_stock'
          : 'out_of_stock',
        requiresEmail: false,
        description: p.description || '',
        currency: 'USD',
        supplierCode: this.code,
      }));

      if (search && search.trim()) {
        const q = search.toLowerCase().trim();
        products = products.filter(
          (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
        );
      }

      return products;
    } catch (err: any) {
      throw new Error(`PrimeDigital getProductList failed: ${err.message}`);
    }
  }

  async getProduct(id: string): Promise<Product | null> {
    try {
      const { data } = await this.client.get(`/api/v1/products/${id}`);
      const p = data.data || data.product || data;
      if (!p || !p.id) return null;

      return {
        id: p.id,
        name: p.name,
        price: p.price ?? 0,
        stock: p.stock ?? 0,
        availability: p.inStock !== false && (p.stock === undefined || p.stock > 0)
          ? 'in_stock'
          : 'out_of_stock',
        requiresEmail: false,
        description: p.description || '',
        currency: 'USD',
        supplierCode: this.code,
      };
    } catch (err: any) {
      if (err.response?.status === 404) return null;
      throw new Error(`PrimeDigital getProduct failed: ${err.message}`);
    }
  }

  async purchaseProduct(params: PurchaseParams): Promise<PurchaseResult> {
    const start = Date.now();
    const payload: Record<string, any> = {
      productId: params.productId,
      quantity: params.qty,
    };

    await appendLog(params.transactionId, 'SUPPLIER_REQ', {
      supplier: this.code,
      ...payload,
    });

    try {
      const { data } = await this.client.post('/api/v1/orders', payload, {
        headers: {
          'Idempotency-Key': params.transactionId,
        },
        timeout: 30000,
      });

      const duration = Date.now() - start;
      await appendLog(params.transactionId, 'SUPPLIER_RES', data, 201, duration);

      const orderData = data.data || data;
      let deliveredKeys: string[] =
        orderData.deliveredKeys ||
        orderData.keys ||
        (orderData.key ? [orderData.key] : []);

      if (deliveredKeys.length === 0) {
        deliveredKeys = ['HUBUNGI_ADMIN:DIRECT_TOPUP_' + params.transactionId];
      }

      return {
        orderId: String(orderData.id || params.transactionId),
        deliveredKeys,
        balance: {
          deducted: orderData.amount,
        },
      };
    } catch (err: any) {
      const duration = Date.now() - start;
      const status = err.response?.status;
      const resData = err.response?.data;

      await appendLog(
        params.transactionId,
        'SUPPLIER_RES',
        resData || { error: err.message },
        status,
        duration
      );

      const errCode = resData?.error?.code;
      const errMsg = resData?.error?.message || err.message;

      // 402 Insufficient Balance
      if (status === 402 || errCode === 'INSUFFICIENT_BALANCE') {
        throw new SupplierRejectedError(`PrimeDigital Insufficient Balance: ${errMsg}`);
      }

      // 409 Out of Stock or conflict
      if (status === 409 || errCode === 'OUT_OF_STOCK') {
        throw new SupplierRejectedError(`PrimeDigital Out of Stock: ${errMsg}`);
      }

      // 400 Bad Request
      if (status === 400) {
        throw new SupplierRejectedError(`PrimeDigital Validation Error: ${errMsg}`);
      }

      // 502 Supplier failure refunded
      if (status === 502) {
        throw new SupplierFailedRefundedError(`PrimeDigital Supplier Unfulfilled (Refunded): ${errMsg}`);
      }

      // 500, 504, timeout
      if (!status || status >= 500) {
        throw new SupplierUnknownOutcomeError(`PrimeDigital Server Error (${status}): ${errMsg}`);
      }

      throw new Error(`PrimeDigital Purchase Failed: ${errMsg}`);
    }
  }

  async findRecentOrder(match: { productId: string; qty: number; since: Date }): Promise<PurchaseResult | null> {
    try {
      const { data } = await this.client.get('/api/v1/orders', {
        params: { limit: 20 },
      });

      const orders = data.data?.orders || data.orders || [];
      const matched = orders.find((o: any) => {
        const orderTime = new Date(o.timestamp || o.created_at || o.createdAt);
        return (
          (o.product_id === match.productId || o.productId === match.productId) &&
          orderTime >= match.since &&
          o.status === 'completed'
        );
      });

      if (!matched) return null;

      const deliveredKeys = matched.deliveredKeys || matched.keys || [];
      return {
        orderId: String(matched.id),
        deliveredKeys,
        balance: { deducted: matched.amount },
      };
    } catch (err) {
      return null;
    }
  }

  async getBalance(): Promise<number> {
    try {
      const { data } = await this.client.get('/api/v1/balance');
      const bal = data.data?.balance ?? data.balance ?? 0;
      return typeof bal === 'number' ? bal : parseFloat(bal) || 0;
    } catch (err: any) {
      throw new Error(`PrimeDigital getBalance failed: ${err.message}`);
    }
  }
}
