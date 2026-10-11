import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { PrimeDigitalAdapter } from '../suppliers/adapters/PrimeDigital.adapter';
import { supplierFactory } from '../suppliers/SupplierFactory';
import { SupplierRejectedError, SupplierFailedRefundedError } from '../suppliers/ISupplierAdapter';

vi.mock('axios');
vi.mock('../services/transactionService', () => ({
  appendLog: vi.fn().mockResolvedValue(undefined),
}));

describe('PrimeDigitalAdapter', () => {
  let adapter: PrimeDigitalAdapter;
  let mockAxiosInstance: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAxiosInstance = {
      get: vi.fn(),
      post: vi.fn(),
    };
    (axios.create as any).mockReturnValue(mockAxiosInstance);
    adapter = new PrimeDigitalAdapter();
  });

  it('getProductList returns mapped products with USD currency and PDA supplierCode', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        data: [
          {
            id: 'pda_canva',
            name: 'Canva Pro 1M',
            price: 1.5,
            stock: 20,
            inStock: true,
            description: 'Canva invite',
          },
          {
            id: 'pda_gmail',
            name: 'Gmail Account',
            price: 0.9,
            stock: 0,
            inStock: false,
            description: 'Fresh Gmail',
          },
        ],
      },
    });

    const products = await adapter.getProductList();
    expect(products).toHaveLength(2);
    expect(products[0]).toEqual({
      id: 'pda_canva',
      name: 'Canva Pro 1M',
      price: 1.5,
      stock: 20,
      availability: 'in_stock',
      requiresEmail: false,
      description: 'Canva invite',
      currency: 'USD',
      supplierCode: 'PDA',
    });
    expect(products[1].availability).toBe('out_of_stock');
  });

  it('getProductList filters products by keyword', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        data: [
          { id: '1', name: 'Canva Pro', price: 1.5, inStock: true },
          { id: '2', name: 'Netflix Premium', price: 3.0, inStock: true },
        ],
      },
    });

    const products = await adapter.getProductList('canva');
    expect(products).toHaveLength(1);
    expect(products[0].name).toBe('Canva Pro');
  });

  it('getProduct returns single product or null on 404', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        data: { id: 'pda_1', name: 'Adobe Express', price: 2.0, inStock: true },
      },
    });

    const product = await adapter.getProduct('pda_1');
    expect(product?.name).toBe('Adobe Express');
    expect(product?.supplierCode).toBe('PDA');

    mockAxiosInstance.get.mockRejectedValueOnce({
      response: { status: 404 },
    });
    const notFound = await adapter.getProduct('non_existent');
    expect(notFound).toBeNull();
  });

  it('purchaseProduct fulfills order and returns keys', async () => {
    mockAxiosInstance.post.mockResolvedValueOnce({
      status: 201,
      data: {
        success: true,
        data: {
          id: 9999,
          amount: 1.5,
          deliveredKeys: ['PDA-KEY-ABC-123'],
        },
      },
    });

    const result = await adapter.purchaseProduct({
      productId: 'pda_canva',
      qty: 1,
      transactionId: 'BRG-20261011-PDA01',
    });

    expect(result.deliveredKeys).toEqual(['PDA-KEY-ABC-123']);
    expect(result.orderId).toBe('9999');
    expect(result.balance.deducted).toBe(1.5);
  });

  it('purchaseProduct throws SupplierRejectedError on 402 Insufficient Balance', async () => {
    mockAxiosInstance.post.mockRejectedValueOnce({
      response: {
        status: 402,
        data: {
          success: false,
          error: { code: 'INSUFFICIENT_BALANCE', message: 'Balance too low' },
        },
      },
    });

    await expect(
      adapter.purchaseProduct({
        productId: 'pda_canva',
        qty: 1,
        transactionId: 'BRG-20261011-PDA02',
      })
    ).rejects.toThrow(SupplierRejectedError);
  });

  it('purchaseProduct throws SupplierFailedRefundedError on 502', async () => {
    mockAxiosInstance.post.mockRejectedValueOnce({
      response: {
        status: 502,
        data: {
          success: false,
          error: { code: 'UPSTREAM_FAILURE', message: 'Supplier failed to fulfill' },
        },
      },
    });

    await expect(
      adapter.purchaseProduct({
        productId: 'pda_canva',
        qty: 1,
        transactionId: 'BRG-20261011-PDA03',
      })
    ).rejects.toThrow(SupplierFailedRefundedError);
  });

  it('getBalance returns numeric balance from Prime Digital API', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        data: { balance: 25.5 },
      },
    });

    const bal = await adapter.getBalance();
    expect(bal).toBe(25.5);
  });
});

describe('SupplierFactory Multi-Supplier Management', () => {
  it('registers both RZK and PDA adapters', () => {
    const rzk = supplierFactory.getAdapter('RZK');
    const pda = supplierFactory.getAdapter('PDA');
    expect(rzk.code).toBe('RZK');
    expect(pda.code).toBe('PDA');

    const all = supplierFactory.getAllAdapters();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.map((a) => a.code)).toContain('RZK');
    expect(all.map((a) => a.code)).toContain('PDA');
  });

  it('findBestOffer selects in-stock product with lowest price across suppliers', async () => {
    const mockRzk = {
      code: 'RZK',
      displayName: 'Rezeki Shop',
      getProductList: vi.fn().mockResolvedValue([
        { id: 'rzk_canva', name: 'Canva Pro', price: 25000, availability: 'in_stock', stock: 5 },
      ]),
    };
    const mockPda = {
      code: 'PDA',
      displayName: 'Prime Digital AI',
      getProductList: vi.fn().mockResolvedValue([
        { id: 'pda_canva', name: 'Canva Pro', price: 15000, availability: 'in_stock', stock: 10 },
      ]),
    };

    // Temporarily replace adapters for testing comparison
    const factory = new (supplierFactory.constructor as any)();
    factory.register(mockRzk);
    factory.register(mockPda);

    const bestOffer = await factory.findBestOffer('Canva');
    expect(bestOffer).not.toBeNull();
    expect(bestOffer?.adapter.code).toBe('PDA');
    expect(bestOffer?.product.price).toBe(15000);
  });
});
