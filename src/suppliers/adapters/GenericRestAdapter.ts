import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { Product, PurchaseParams, PurchaseResult } from '../types';
import {
  ISupplierAdapter,
  SupplierRejectedError,
  SupplierFailedRefundedError,
  SupplierUnknownOutcomeError,
} from '../ISupplierAdapter';
import { appendLog } from '../../services/transactionService';

export interface GenericDescriptorMapping {
  id?: string;
  name?: string;
  price?: string;
  stock?: string;
  availability?: string;
  requiresEmail?: string;
  description?: string;
  categorySlug?: string;
  tags?: string;
}

export interface GenericSupplierDescriptor {
  version?: string;
  headers?: Record<string, string>;
  auth?: {
    type?: 'API_KEY' | 'BEARER' | 'BASIC' | 'CUSTOM';
    headerName?: string;
    headerPrefix?: string;
    queryParam?: string;
    customHeaders?: Record<string, string>;
  };
  endpoints?: {
    balance?: {
      path: string;
      method?: 'GET' | 'POST';
      responsePath?: string;
    };
    productList?: {
      path: string;
      method?: 'GET' | 'POST';
      searchParam?: string;
      responsePath?: string;
      mapping?: GenericDescriptorMapping;
    };
    productDetail?: {
      path: string;
      method?: 'GET' | 'POST';
      responsePath?: string;
      mapping?: GenericDescriptorMapping;
    };
    order?: {
      path: string;
      method?: 'POST';
      bodyTemplate?: Record<string, any>;
      response?: {
        orderIdPath?: string;
        keysPath?: string;
        balanceBeforePath?: string;
        balanceDeductedPath?: string;
        balanceRefundedPath?: string;
        balanceAfterPath?: string;
      };
    };
    recentOrders?: {
      path: string;
      method?: 'GET';
      responsePath?: string;
      mapping?: {
        orderId?: string;
        productId?: string;
        qty?: string;
        createdAt?: string;
        keys?: string;
      };
    };
  };
}

export interface GenericRestAdapterOptions {
  code: string;
  displayName: string;
  baseUrl: string;
  authType: string;
  credentials: Record<string, any> | string;
  descriptor: GenericSupplierDescriptor | string;
  timeout?: number;
}

/**
 * Safely extracts nested property from object using dot notation (e.g. "data.balance").
 */
export function getNestedValue(obj: any, path?: string): any {
  if (!obj || !path || path === '.' || path === '') return obj;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

export class GenericRestAdapter implements ISupplierAdapter {
  code: string;
  displayName: string;
  baseUrl: string;
  authType: string;
  descriptor: GenericSupplierDescriptor;
  private client: AxiosInstance;
  private credentials: Record<string, any> | string;

  constructor(options: GenericRestAdapterOptions) {
    this.code = options.code.toUpperCase();
    this.displayName = options.displayName;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.authType = options.authType.toUpperCase();
    this.credentials = options.credentials;

    if (typeof options.descriptor === 'string') {
      try {
        this.descriptor = JSON.parse(options.descriptor);
      } catch (e: any) {
        throw new Error(`Invalid JSON descriptor for supplier ${this.code}: ${e.message}`);
      }
    } else {
      this.descriptor = options.descriptor || {};
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(this.descriptor.headers || {}),
    };

    // Apply authentication
    this.applyAuth(headers);

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers,
      timeout: options.timeout || 15000,
    });
  }

  private applyAuth(headers: Record<string, string>) {
    const cred = this.credentials;
    const authConfig = this.descriptor.auth || {};

    if (this.authType === 'API_KEY') {
      const headerName = authConfig.headerName || 'X-API-KEY';
      const keyVal = typeof cred === 'string' ? cred : cred.apiKey || cred.api_key || cred.key || cred.secret || '';
      if (keyVal) {
        headers[headerName] = (authConfig.headerPrefix || '') + keyVal;
      }
    } else if (this.authType === 'BEARER') {
      const token = typeof cred === 'string' ? cred : cred.token || cred.apiKey || cred.api_key || '';
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    } else if (this.authType === 'BASIC') {
      if (typeof cred === 'object') {
        const username = cred.username || cred.user || '';
        const password = cred.password || cred.pass || '';
        const encoded = Buffer.from(`${username}:${password}`).toString('base64');
        headers['Authorization'] = `Basic ${encoded}`;
      }
    } else if (this.authType === 'CUSTOM' && authConfig.customHeaders) {
      Object.assign(headers, authConfig.customHeaders);
    }
  }

  async getBalance(): Promise<number> {
    const balanceCfg = this.descriptor.endpoints?.balance;
    if (!balanceCfg || !balanceCfg.path) {
      throw new Error(`Supplier ${this.code} does not configure balance endpoint`);
    }

    try {
      const res = await this.client.request({
        url: balanceCfg.path,
        method: balanceCfg.method || 'GET',
      });

      const extracted = getNestedValue(res.data, balanceCfg.responsePath || 'balance');
      const num = Number(extracted);
      if (isNaN(num)) {
        // Fallback: try data.balance or balance if responsePath didn't hit
        const alt = res.data?.data?.balance ?? res.data?.balance ?? res.data?.data ?? res.data;
        const altNum = Number(alt);
        return isNaN(altNum) ? 0 : altNum;
      }
      return num;
    } catch (err: any) {
      throw new Error(`GenericRestAdapter [${this.code}] getBalance failed: ${err.message}`);
    }
  }

  async getProductList(search?: string): Promise<Product[]> {
    const listCfg = this.descriptor.endpoints?.productList;
    if (!listCfg || !listCfg.path) {
      throw new Error(`Supplier ${this.code} does not configure productList endpoint`);
    }

    try {
      const params: Record<string, any> = {};
      if (search && listCfg.searchParam) {
        params[listCfg.searchParam] = search;
      }

      const res = await this.client.request({
        url: listCfg.path,
        method: listCfg.method || 'GET',
        params,
      });

      const rawItems = getNestedValue(res.data, listCfg.responsePath) ?? res.data;
      const items = Array.isArray(rawItems)
        ? rawItems
        : (rawItems?.products || rawItems?.data || rawItems?.items || []);

      const mapping = listCfg.mapping || {};

      return items.map((item: any) => {
        const id = String(getNestedValue(item, mapping.id || 'id') ?? item.code ?? item.product_id ?? '');
        const name = String(getNestedValue(item, mapping.name || 'name') ?? item.product_name ?? item.title ?? 'Unknown');
        const priceVal = getNestedValue(item, mapping.price || 'price') ?? item.price_idr ?? 0;
        const stockVal = getNestedValue(item, mapping.stock || 'stock');
        const availVal = getNestedValue(item, mapping.availability || 'availability');

        let availability: 'in_stock' | 'out_of_stock' = 'in_stock';
        if (availVal === 'out_of_stock' || availVal === false || availVal === 0) {
          availability = 'out_of_stock';
        } else if (stockVal !== undefined && Number(stockVal) <= 0) {
          availability = 'out_of_stock';
        }

        const requiresEmail = Boolean(getNestedValue(item, mapping.requiresEmail || 'requires_email') ?? false);
        const description = String(getNestedValue(item, mapping.description || 'description') ?? '');
        const categorySlug = getNestedValue(item, mapping.categorySlug || 'category_slug') ?? item.category;
        const tags = getNestedValue(item, mapping.tags || 'tags');

        return {
          id,
          name,
          price: Number(priceVal) || 0,
          stock: stockVal !== undefined ? Number(stockVal) : undefined,
          availability,
          requiresEmail,
          description,
          categorySlug: categorySlug ? String(categorySlug) : undefined,
          tags: Array.isArray(tags) ? tags : undefined,
          currency: 'IDR',
          supplierCode: this.code,
        };
      });
    } catch (err: any) {
      throw new Error(`GenericRestAdapter [${this.code}] getProductList failed: ${err.message}`);
    }
  }

  async getProduct(id: string): Promise<Product | null> {
    const detailCfg = this.descriptor.endpoints?.productDetail;
    if (detailCfg && detailCfg.path) {
      const url = detailCfg.path.replace('{id}', encodeURIComponent(id)).replace(':id', encodeURIComponent(id));
      try {
        const res = await this.client.request({
          url,
          method: detailCfg.method || 'GET',
        });
        const raw = getNestedValue(res.data, detailCfg.responsePath) ?? res.data;
        const mapping = detailCfg.mapping || {};
        return {
          id: String(getNestedValue(raw, mapping.id || 'id') ?? id),
          name: String(getNestedValue(raw, mapping.name || 'name') ?? 'Unknown'),
          price: Number(getNestedValue(raw, mapping.price || 'price') ?? 0),
          stock: getNestedValue(raw, mapping.stock || 'stock') !== undefined ? Number(getNestedValue(raw, mapping.stock || 'stock')) : undefined,
          availability: 'in_stock',
          requiresEmail: Boolean(getNestedValue(raw, mapping.requiresEmail || 'requires_email') ?? false),
          description: String(getNestedValue(raw, mapping.description || 'description') ?? ''),
          currency: 'IDR',
          supplierCode: this.code,
        };
      } catch (err: any) {
        if (err.response?.status === 404) return null;
      }
    }

    // Fallback: search in getProductList
    const list = await this.getProductList();
    return list.find((p) => p.id === id) || null;
  }

  async purchaseProduct(params: PurchaseParams): Promise<PurchaseResult> {
    const orderCfg = this.descriptor.endpoints?.order;
    if (!orderCfg || !orderCfg.path) {
      throw new Error(`Supplier ${this.code} does not configure order endpoint`);
    }

    const start = Date.now();

    // Build payload from template
    let payload: any = {};
    if (orderCfg.bodyTemplate) {
      const tpl = JSON.stringify(orderCfg.bodyTemplate);
      const emailVal = params.emails && params.emails.length > 0 ? params.emails[0] : '';
      const emailsVal = JSON.stringify(params.emails || []);

      const replaced = tpl
        .replace(/"\{productId\}"/g, JSON.stringify(params.productId))
        .replace(/"\{qty\}"/g, String(params.qty))
        .replace(/"\{email\}"/g, JSON.stringify(emailVal))
        .replace(/"\{emails\}"/g, emailsVal)
        .replace(/"\{transactionId\}"/g, JSON.stringify(params.transactionId));

      payload = JSON.parse(replaced);
    } else {
      payload = {
        product_id: params.productId,
        quantity: params.qty,
        email: params.emails?.[0],
        transaction_id: params.transactionId,
      };
    }

    await appendLog(params.transactionId, 'SUPPLIER_REQ', payload);

    try {
      const res = await this.client.request({
        url: orderCfg.path,
        method: orderCfg.method || 'POST',
        data: payload,
        timeout: 30000,
      });

      const duration = Date.now() - start;
      await appendLog(params.transactionId, 'SUPPLIER_RES', res.data, res.status, duration);

      const resMapping = orderCfg.response || {};
      const orderId = String(getNestedValue(res.data, resMapping.orderIdPath || 'order_id') ?? params.transactionId);

      const rawKeys = getNestedValue(res.data, resMapping.keysPath || 'delivered_keys');
      let deliveredKeys: string[] = [];
      if (Array.isArray(rawKeys)) {
        deliveredKeys = rawKeys.map(String);
      } else if (typeof rawKeys === 'string' && rawKeys.trim().length > 0) {
        deliveredKeys = [rawKeys.trim()];
      }

      if (deliveredKeys.length === 0) {
        deliveredKeys = [`HUBUNGI_ADMIN:GENERIC_ORDER_${params.transactionId}`];
      }

      const balBefore = getNestedValue(res.data, resMapping.balanceBeforePath || 'balance.before');
      const balDeducted = getNestedValue(res.data, resMapping.balanceDeductedPath || 'balance.deducted');
      const balRefunded = getNestedValue(res.data, resMapping.balanceRefundedPath || 'balance.refunded');
      const balAfter = getNestedValue(res.data, resMapping.balanceAfterPath || 'balance.after');

      return {
        orderId,
        deliveredKeys,
        balance: {
          before: balBefore !== undefined ? Number(balBefore) : undefined,
          deducted: balDeducted !== undefined ? Number(balDeducted) : undefined,
          refunded: balRefunded !== undefined ? Number(balRefunded) : undefined,
          after: balAfter !== undefined ? Number(balAfter) : undefined,
        },
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
    const recentCfg = this.descriptor.endpoints?.recentOrders;
    if (!recentCfg || !recentCfg.path) return null;

    try {
      const res = await this.client.request({
        url: recentCfg.path,
        method: recentCfg.method || 'GET',
      });

      const rawItems = getNestedValue(res.data, recentCfg.responsePath) ?? res.data;
      const items = Array.isArray(rawItems) ? rawItems : (rawItems?.orders || rawItems?.data || []);
      const mapping = recentCfg.mapping || {};

      const found = items.find((o: any) => {
        const pId = String(getNestedValue(o, mapping.productId || 'product_id'));
        const q = Number(getNestedValue(o, mapping.qty || 'quantity'));
        const dateRaw = getNestedValue(o, mapping.createdAt || 'created_at');
        const created = new Date(dateRaw || Date.now());
        return created >= match.since && pId === match.productId && q === match.qty;
      });

      if (!found) return null;

      const orderId = String(getNestedValue(found, mapping.orderId || 'id') || '');
      const rawKeys = getNestedValue(found, mapping.keys || 'delivered_keys');
      const deliveredKeys = Array.isArray(rawKeys)
        ? rawKeys.map(String)
        : rawKeys
        ? [String(rawKeys)]
        : [];

      return {
        orderId,
        deliveredKeys,
        balance: {},
      };
    } catch {
      return null;
    }
  }
}
