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

export class DigitalAIStoreAdapter implements ISupplierAdapter {
  code = 'DAI';
  displayName = 'Digital AI Store';
  private client: AxiosInstance;
  private apiKey: string;
  private baseURL: string;

  constructor() {
    this.baseURL = env.SUPPLIER_DAI_BASE_URL || process.env.SUPLIER_DAI_BASE_URL || 'http://43.156.46.152:8000';
    this.apiKey = env.SUPPLIER_DAI_API_KEY || process.env.DAI_API_KEY || '';

    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'X-API-KEY': this.apiKey,
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
  }

  /**
   * Checks if the DAI reseller API key has been configured by the admin.
   */
  isConfigured(): boolean {
    return Boolean(
      this.apiKey &&
      this.apiKey.trim() !== '' &&
      !this.apiKey.includes('your_') &&
      !this.apiKey.includes('placeholder')
    );
  }

  async getProductList(search?: string): Promise<Product[]> {
    if (!this.isConfigured()) {
      throw new Error(
        'Digital AI Store (DAI) API key is not configured yet in .env (set SUPPLIER_DAI_API_KEY or DAI_API_KEY)'
      );
    }

    try {
      const { data } = await this.client.get('/api/v1/products');
      const rawProducts: any[] = Array.isArray(data)
        ? data
        : (data.data || data.products || []);

      const products: Product[] = [];

      for (const p of rawProducts) {
        const prodId = p.product_id || p.id;
        const prodName = p.name || prodId;
        const prodDesc = p.description || '';

        if (Array.isArray(p.plans) && p.plans.length > 0) {
          // Flatten multi-plan products into individual bridge catalog items
          for (const plan of p.plans) {
            const planId = plan.plan_id || plan.id;
            const planName = plan.name || planId;
            const stock = plan.stock ?? (plan.in_stock ? 99 : 0);
            const isInStock = plan.in_stock !== false && (plan.stock === undefined || plan.stock > 0);

            products.push({
              id: `${prodId}:${planId}`,
              name: `${prodName} - ${planName}`,
              price: plan.price ?? p.price ?? 0,
              stock,
              availability: isInStock ? 'in_stock' : 'out_of_stock',
              requiresEmail: false,
              description: plan.description || prodDesc,
              currency: 'USD',
              supplierCode: this.code,
            });
          }
        } else {
          // Single flat product
          const stock = p.stock ?? (p.in_stock ? 99 : 0);
          const isInStock = p.in_stock !== false && (p.stock === undefined || p.stock > 0);

          products.push({
            id: String(prodId),
            name: prodName,
            price: p.price ?? 0,
            stock,
            availability: isInStock ? 'in_stock' : 'out_of_stock',
            requiresEmail: false,
            description: prodDesc,
            currency: 'USD',
            supplierCode: this.code,
          });
        }
      }

      if (search && search.trim()) {
        const q = search.toLowerCase().trim();
        return products.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            p.id.toLowerCase().includes(q)
        );
      }

      return products;
    } catch (err: any) {
      throw new Error(`Digital AI Store getProductList failed: ${err.message}`);
    }
  }

  async getProduct(id: string): Promise<Product | null> {
    try {
      const products = await this.getProductList();
      const match = products.find((p) => p.id === id || p.id.toLowerCase() === id.toLowerCase());
      return match || null;
    } catch (err: any) {
      if (err.response?.status === 404) return null;
      throw new Error(`Digital AI Store getProduct failed: ${err.message}`);
    }
  }

  async purchaseProduct(params: PurchaseParams): Promise<PurchaseResult> {
    if (!this.isConfigured()) {
      throw new SupplierRejectedError(
        'Digital AI Store (DAI) API key is not configured yet in .env (set SUPPLIER_DAI_API_KEY or DAI_API_KEY)'
      );
    }

    const start = Date.now();

    // Parse product_id and plan_id from composite or single format
    let productId = params.productId;
    let planId = (params as any).planId || (params as any).plan_id || '';

    if (!planId) {
      if (productId.includes(':')) {
        const parts = productId.split(':');
        productId = parts[0];
        planId = parts[1];
      } else if (productId.includes('__')) {
        const parts = productId.split('__');
        productId = parts[0];
        planId = parts[1];
      } else {
        planId = 'default';
      }
    }

    // DAI limits quantity between 1 and 50
    const qty = Math.min(Math.max(params.qty || 1, 1), 50);

    const payload = {
      product_id: productId,
      plan_id: planId,
      qty,
    };

    await appendLog(params.transactionId, 'SUPPLIER_REQ', {
      supplier: this.code,
      ...payload,
    });

    try {
      const { data } = await this.client.post('/api/v1/order', payload, {
        headers: {
          'Idempotency-Key': params.transactionId,
        },
        timeout: 30000,
      });

      const duration = Date.now() - start;
      await appendLog(params.transactionId, 'SUPPLIER_RES', data, 200, duration);

      const orderData = data.data || data;
      const orderId = String(
        orderData.order_code ||
        orderData.order_id ||
        orderData.id ||
        params.transactionId
      );

      // Extract delivered account credentials (email, password, 2FA, token, keys)
      const deliveredKeys = this.extractDeliveredKeys(orderData, orderId);

      return {
        orderId,
        deliveredKeys,
        balance: {
          deducted: orderData.amount || orderData.price || orderData.total,
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

      const detail = resData?.detail || resData?.message || resData?.error?.message || err.message;
      const errCode = resData?.error?.code || resData?.code;

      // 401 Unauthorized / Invalid API Key
      if (status === 401) {
        throw new SupplierRejectedError(`Digital AI Store Authentication Failed: ${detail}`);
      }

      // 402 Insufficient Balance
      if (status === 402 || errCode === 'INSUFFICIENT_BALANCE' || String(detail).toLowerCase().includes('balance')) {
        throw new SupplierRejectedError(`Digital AI Store Insufficient Balance: ${detail}`);
      }

      // 422 / 400 Bad Request or Validation Error
      if (status === 400 || status === 422) {
        const valDetail = Array.isArray(resData?.detail)
          ? resData.detail.map((d: any) => `${d.loc?.join('.')}: ${d.msg}`).join(', ')
          : detail;
        throw new SupplierRejectedError(`Digital AI Store Validation Error: ${valDetail}`);
      }

      // 404 Not Found
      if (status === 404) {
        throw new SupplierRejectedError(`Digital AI Store Product Not Found: ${detail}`);
      }

      // 409 Out of Stock
      if (status === 409 || errCode === 'OUT_OF_STOCK' || String(detail).toLowerCase().includes('stock')) {
        throw new SupplierRejectedError(`Digital AI Store Out of Stock: ${detail}`);
      }

      // 502 Upstream failure refunded
      if (status === 502) {
        throw new SupplierFailedRefundedError(`Digital AI Store Supplier Unfulfilled (Refunded): ${detail}`);
      }

      // 500, 504, timeout
      if (!status || status >= 500) {
        throw new SupplierUnknownOutcomeError(`Digital AI Store Server Error (${status}): ${detail}`);
      }

      throw new Error(`Digital AI Store Purchase Failed: ${detail}`);
    }
  }

  async findRecentOrder(match: { productId: string; qty: number; since: Date }): Promise<PurchaseResult | null> {
    if (!this.isConfigured()) return null;

    try {
      const { data } = await this.client.get('/api/v1/orders', {
        params: { limit: 20 },
      });

      const orders: any[] = Array.isArray(data)
        ? data
        : (data.data?.orders || data.orders || data.data || []);

      const matched = orders.find((o: any) => {
        const orderTime = new Date(o.timestamp || o.created_at || o.createdAt || o.time);
        const prodMatch =
          o.product_id === match.productId ||
          `${o.product_id}:${o.plan_id}` === match.productId ||
          o.productId === match.productId;

        return (
          prodMatch &&
          orderTime >= match.since &&
          (o.status === 'completed' || o.status === 'success' || !o.status)
        );
      });

      if (!matched) return null;

      const orderId = String(matched.order_code || matched.order_id || matched.id);
      const deliveredKeys = this.extractDeliveredKeys(matched, orderId);

      return {
        orderId,
        deliveredKeys,
        balance: { deducted: matched.amount || matched.price || matched.total },
      };
    } catch {
      return null;
    }
  }

  async getBalance(): Promise<number> {
    if (!this.isConfigured()) {
      throw new Error(
        'Digital AI Store (DAI) API key is not configured yet in .env (set SUPPLIER_DAI_API_KEY or DAI_API_KEY)'
      );
    }

    try {
      const { data } = await this.client.get('/api/v1/balance');
      const bal = data.data?.balance ?? data.balance ?? data.wallet_balance ?? 0;
      return typeof bal === 'number' ? bal : parseFloat(bal) || 0;
    } catch (err: any) {
      throw new Error(`Digital AI Store getBalance failed: ${err.message}`);
    }
  }

  private extractDeliveredKeys(data: any, fallbackId: string): string[] {
    let keys: string[] = [];

    if (Array.isArray(data.credentials)) {
      keys = data.credentials.map((c: any) => this.formatCredential(c));
    } else if (data.credentials && typeof data.credentials === 'object') {
      keys = [this.formatCredential(data.credentials)];
    } else if (Array.isArray(data.accounts)) {
      keys = data.accounts.map((a: any) => this.formatCredential(a));
    } else if (Array.isArray(data.keys)) {
      keys = data.keys.map((k: any) => (typeof k === 'string' ? k : JSON.stringify(k)));
    } else if (Array.isArray(data.deliveredKeys)) {
      keys = data.deliveredKeys;
    } else if (data.key) {
      keys = [String(data.key)];
    } else if (data.credential) {
      keys = [this.formatCredential(data.credential)];
    }

    if (keys.length === 0) {
      keys = [`HUBUNGI_ADMIN:DAI_ORDER_${fallbackId}`];
    }

    return keys;
  }

  private formatCredential(c: any): string {
    if (typeof c === 'string') return c;
    if (!c || typeof c !== 'object') return String(c);

    const parts: string[] = [];
    if (c.email) parts.push(`Email: ${c.email}`);
    if (c.password) parts.push(`Password: ${c.password}`);
    if (c.two_factor || c['2fa'] || c.twoFactor) {
      parts.push(`2FA: ${c.two_factor || c['2fa'] || c.twoFactor}`);
    }
    if (c.token) parts.push(`Token: ${c.token}`);
    if (c.license_key || c.licenseKey || c.license) {
      parts.push(`License: ${c.license_key || c.licenseKey || c.license}`);
    }
    if (c.pin) parts.push(`PIN: ${c.pin}`);
    if (c.url) parts.push(`Login: ${c.url}`);

    return parts.length > 0 ? parts.join(' | ') : JSON.stringify(c);
  }
}
