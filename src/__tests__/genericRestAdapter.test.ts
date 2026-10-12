import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { GenericRestAdapter, getNestedValue } from '../suppliers/adapters/GenericRestAdapter';
import {
  SupplierRejectedError,
  SupplierFailedRefundedError,
  SupplierUnknownOutcomeError,
} from '../suppliers/ISupplierAdapter';

vi.mock('axios');
vi.mock('../services/transactionService', () => ({
  appendLog: vi.fn().mockResolvedValue(undefined),
}));

describe('P2b GenericRestAdapter & JSON Descriptor', () => {
  const mockAxiosInstance = {
    request: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (axios.create as any).mockReturnValue(mockAxiosInstance);
  });

  const sampleDescriptor = {
    version: '1.0',
    auth: {
      type: 'API_KEY' as const,
      headerName: 'X-API-KEY',
    },
    endpoints: {
      balance: {
        path: '/v1/balance',
        method: 'GET' as const,
        responsePath: 'data.balance',
      },
      productList: {
        path: '/v1/products',
        method: 'GET' as const,
        searchParam: 'query',
        responsePath: 'data.products',
        mapping: {
          id: 'code',
          name: 'title',
          price: 'price_idr',
          stock: 'inventory',
          availability: 'status',
          requiresEmail: 'needs_email',
          description: 'details',
        },
      },
      productDetail: {
        path: '/v1/products/{id}',
        method: 'GET' as const,
        responsePath: 'data',
        mapping: {
          id: 'code',
          name: 'title',
          price: 'price_idr',
          stock: 'inventory',
        },
      },
      order: {
        path: '/v1/buy',
        method: 'POST' as const,
        bodyTemplate: {
          item_code: '{productId}',
          count: '{qty}',
          target_email: '{email}',
          client_ref: '{transactionId}',
        },
        response: {
          orderIdPath: 'data.trx_id',
          keysPath: 'data.keys',
          balanceBeforePath: 'data.balance.before',
          balanceDeductedPath: 'data.balance.spent',
          balanceAfterPath: 'data.balance.remaining',
        },
      },
    },
  };

  it('correctly extracts nested properties via getNestedValue', () => {
    const data = {
      user: {
        profile: {
          name: 'Alice',
          balance: 150000,
        },
      },
      items: [1, 2, 3],
    };

    expect(getNestedValue(data, 'user.profile.name')).toBe('Alice');
    expect(getNestedValue(data, 'user.profile.balance')).toBe(150000);
    expect(getNestedValue(data, 'items')).toEqual([1, 2, 3]);
    expect(getNestedValue(data, 'user.nonexistent')).toBeUndefined();
    expect(getNestedValue(data, '')).toEqual(data);
  });

  it('initializes with API_KEY auth headers and fetches balance successfully', async () => {
    const adapter = new GenericRestAdapter({
      code: 'DGF',
      displayName: 'Digiflazz Generic',
      baseUrl: 'https://api.digiflazz.test',
      authType: 'API_KEY',
      credentials: { apiKey: 'secret-key-123' },
      descriptor: sampleDescriptor,
    });

    mockAxiosInstance.request.mockResolvedValueOnce({
      status: 200,
      data: {
        data: {
          balance: 750000,
        },
      },
    });

    const balance = await adapter.getBalance();
    expect(balance).toBe(750000);
    expect(mockAxiosInstance.request).toHaveBeenCalledWith({
      url: '/v1/balance',
      method: 'GET',
    });
  });

  it('fetches and maps product list using custom field mappings', async () => {
    const adapter = new GenericRestAdapter({
      code: 'DGF',
      displayName: 'Digiflazz Generic',
      baseUrl: 'https://api.digiflazz.test',
      authType: 'API_KEY',
      credentials: 'secret-key-123',
      descriptor: sampleDescriptor,
    });

    mockAxiosInstance.request.mockResolvedValueOnce({
      status: 200,
      data: {
        data: {
          products: [
            {
              code: 'PROD-NETFLIX-1M',
              title: 'Netflix 1 Bulan Premium',
              price_idr: 45000,
              inventory: 10,
              status: 'in_stock',
              needs_email: true,
              details: 'Akun premium UHD',
            },
            {
              code: 'PROD-SPOTIFY-3M',
              title: 'Spotify 3 Bulan',
              price_idr: 30000,
              inventory: 0,
              status: 'out_of_stock',
              needs_email: false,
              details: 'Family plan slot',
            },
          ],
        },
      },
    });

    const products = await adapter.getProductList('netflix');
    expect(products).toHaveLength(2);

    expect(products[0]).toEqual({
      id: 'PROD-NETFLIX-1M',
      name: 'Netflix 1 Bulan Premium',
      price: 45000,
      stock: 10,
      availability: 'in_stock',
      requiresEmail: true,
      description: 'Akun premium UHD',
      currency: 'IDR',
      categorySlug: undefined,
      tags: undefined,
      supplierCode: 'DGF',
    });

    expect(products[1].availability).toBe('out_of_stock');
  });

  it('purchases product substituting body template and extracting keys', async () => {
    const adapter = new GenericRestAdapter({
      code: 'DGF',
      displayName: 'Digiflazz Generic',
      baseUrl: 'https://api.digiflazz.test',
      authType: 'API_KEY',
      credentials: { apiKey: 'secret-key-123' },
      descriptor: sampleDescriptor,
    });

    mockAxiosInstance.request.mockResolvedValueOnce({
      status: 200,
      data: {
        data: {
          trx_id: 'SUP-TRX-888',
          keys: ['EMAIL:PASS:PIN123'],
          balance: {
            before: 500000,
            spent: 45000,
            remaining: 455000,
          },
        },
      },
    });

    const result = await adapter.purchaseProduct({
      productId: 'PROD-NETFLIX-1M',
      qty: 1,
      emails: ['buyer@example.com'],
      transactionId: 'TX-VL-999',
    });

    expect(result.orderId).toBe('SUP-TRX-888');
    expect(result.deliveredKeys).toEqual(['EMAIL:PASS:PIN123']);
    expect(result.balance.deducted).toBe(45000);
    expect(result.balance.after).toBe(455000);

    expect(mockAxiosInstance.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/v1/buy',
        method: 'POST',
        data: {
          item_code: 'PROD-NETFLIX-1M',
          count: 1,
          target_email: 'buyer@example.com',
          client_ref: 'TX-VL-999',
        },
      })
    );
  });

  it('maps HTTP 400/402/422 to SupplierRejectedError', async () => {
    const adapter = new GenericRestAdapter({
      code: 'DGF',
      displayName: 'Digiflazz Generic',
      baseUrl: 'https://api.digiflazz.test',
      authType: 'API_KEY',
      credentials: 'key',
      descriptor: sampleDescriptor,
    });

    mockAxiosInstance.request.mockRejectedValueOnce({
      response: {
        status: 402,
        data: { error: 'Insufficient balance' },
      },
    });

    await expect(
      adapter.purchaseProduct({
        productId: 'PROD-1',
        qty: 1,
        transactionId: 'TX-ERR-1',
      })
    ).rejects.toThrow(SupplierRejectedError);
  });

  it('maps HTTP 500 to SupplierFailedRefundedError', async () => {
    const adapter = new GenericRestAdapter({
      code: 'DGF',
      displayName: 'Digiflazz Generic',
      baseUrl: 'https://api.digiflazz.test',
      authType: 'API_KEY',
      credentials: 'key',
      descriptor: sampleDescriptor,
    });

    mockAxiosInstance.request.mockRejectedValueOnce({
      response: {
        status: 500,
        data: { message: 'Internal upstream crash' },
      },
    });

    await expect(
      adapter.purchaseProduct({
        productId: 'PROD-1',
        qty: 1,
        transactionId: 'TX-ERR-2',
      })
    ).rejects.toThrow(SupplierFailedRefundedError);
  });

  it('maps network timeout to SupplierUnknownOutcomeError', async () => {
    const adapter = new GenericRestAdapter({
      code: 'DGF',
      displayName: 'Digiflazz Generic',
      baseUrl: 'https://api.digiflazz.test',
      authType: 'API_KEY',
      credentials: 'key',
      descriptor: sampleDescriptor,
    });

    mockAxiosInstance.request.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    await expect(
      adapter.purchaseProduct({
        productId: 'PROD-1',
        qty: 1,
        transactionId: 'TX-ERR-3',
      })
    ).rejects.toThrow(SupplierUnknownOutcomeError);
  });
});
