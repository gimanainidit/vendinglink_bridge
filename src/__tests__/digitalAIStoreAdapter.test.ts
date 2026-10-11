import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { DigitalAIStoreAdapter } from '../suppliers/adapters/DigitalAIStore.adapter';
import { supplierFactory } from '../suppliers/SupplierFactory';
import {
  SupplierRejectedError,
  SupplierFailedRefundedError,
  SupplierUnknownOutcomeError,
} from '../suppliers/ISupplierAdapter';

vi.mock('axios');
vi.mock('../services/transactionService', () => ({
  appendLog: vi.fn().mockResolvedValue(undefined),
}));

describe('DigitalAIStoreAdapter', () => {
  let adapter: DigitalAIStoreAdapter;
  let mockAxiosInstance: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAxiosInstance = {
      get: vi.fn(),
      post: vi.fn(),
    };
    (axios.create as any).mockReturnValue(mockAxiosInstance);
  });

  describe('Unconfigured Key State (Graceful Handling)', () => {
    it('detects unconfigured state when api key is blank or placeholder', () => {
      const emptyAdapter = new DigitalAIStoreAdapter();
      (emptyAdapter as any).apiKey = '';
      expect(emptyAdapter.isConfigured()).toBe(false);

      (emptyAdapter as any).apiKey = 'your_reseller_api_key_here';
      expect(emptyAdapter.isConfigured()).toBe(false);
    });

    it('throws clear descriptive error when calling methods without configured API key', async () => {
      const unconfiguredAdapter = new DigitalAIStoreAdapter();
      (unconfiguredAdapter as any).apiKey = '';

      await expect(unconfiguredAdapter.getProductList()).rejects.toThrow(
        /Digital AI Store \(DAI\) API key is not configured yet in \.env/
      );

      await expect(
        unconfiguredAdapter.purchaseProduct({
          productId: 'chatgpt:plus_1m',
          qty: 1,
          transactionId: 'TX-DAI-001',
        })
      ).rejects.toThrow(SupplierRejectedError);

      await expect(unconfiguredAdapter.getBalance()).rejects.toThrow(
        /Digital AI Store \(DAI\) API key is not configured yet in \.env/
      );

      const recent = await unconfiguredAdapter.findRecentOrder({
        productId: 'chatgpt:plus_1m',
        qty: 1,
        since: new Date(),
      });
      expect(recent).toBeNull();
    });
  });

  describe('Configured Operations with Mock API Key', () => {
    beforeEach(() => {
      adapter = new DigitalAIStoreAdapter();
      (adapter as any).apiKey = 'test_dai_reseller_key_123';
    });

    it('getProductList flattens nested plan products into individual items', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [
          {
            product_id: 'chatgpt',
            name: 'ChatGPT Plus',
            description: 'OpenAI subscription',
            plans: [
              {
                plan_id: 'plus_1m',
                name: '1 Month Private',
                price: 18.5,
                stock: 15,
                in_stock: true,
              },
              {
                plan_id: 'team_1m',
                name: 'Team 1 Month',
                price: 25.0,
                stock: 0,
                in_stock: false,
              },
            ],
          },
          {
            product_id: 'claude_pro',
            name: 'Claude Pro',
            description: 'Anthropic Claude',
            price: 19.0,
            stock: 5,
            in_stock: true,
            plans: [],
          },
        ],
      });

      const products = await adapter.getProductList();
      expect(products).toHaveLength(3);

      // Verify flattened composite product
      expect(products[0]).toEqual({
        id: 'chatgpt:plus_1m',
        name: 'ChatGPT Plus - 1 Month Private',
        price: 18.5,
        stock: 15,
        availability: 'in_stock',
        requiresEmail: false,
        description: 'OpenAI subscription',
        currency: 'USD',
        supplierCode: 'DAI',
      });

      // Verify out of stock plan
      expect(products[1]).toEqual({
        id: 'chatgpt:team_1m',
        name: 'ChatGPT Plus - Team 1 Month',
        price: 25.0,
        stock: 0,
        availability: 'out_of_stock',
        requiresEmail: false,
        description: 'OpenAI subscription',
        currency: 'USD',
        supplierCode: 'DAI',
      });

      // Verify flat product
      expect(products[2].id).toBe('claude_pro');
      expect(products[2].availability).toBe('in_stock');
    });

    it('getProductList filters by search keyword', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [
          {
            product_id: 'chatgpt',
            name: 'ChatGPT Plus',
            plans: [{ plan_id: 'plus_1m', name: '1 Month', price: 18.5, in_stock: true }],
          },
          {
            product_id: 'cursor',
            name: 'Cursor AI Pro',
            plans: [{ plan_id: 'pro_1m', name: '1 Month', price: 16.0, in_stock: true }],
          },
        ],
      });

      const results = await adapter.getProductList('cursor');
      expect(results).toHaveLength(1);
      expect(results[0].name).toContain('Cursor AI');
    });

    it('getProduct finds product by composite ID', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [
          {
            product_id: 'gemini',
            name: 'Gemini Advanced',
            plans: [{ plan_id: 'adv_1m', name: '1 Month', price: 17.0, in_stock: true }],
          },
        ],
      });

      const prod = await adapter.getProduct('gemini:adv_1m');
      expect(prod).not.toBeNull();
      expect(prod?.id).toBe('gemini:adv_1m');
      expect(prod?.price).toBe(17.0);

      mockAxiosInstance.get.mockResolvedValueOnce({ status: 200, data: [] });
      const notFound = await adapter.getProduct('non_existent');
      expect(notFound).toBeNull();
    });

    it('purchaseProduct parses composite ID, sends order, and formats delivered credentials', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        status: 200,
        data: {
          order_code: 'DAI-ORD-88231',
          product_id: 'chatgpt',
          plan_id: 'plus_1m',
          amount: 18.5,
          credentials: [
            {
              email: 'buyer@example.com',
              password: 'secretPassword123',
              two_factor: 'JBSWY3DPEHPK3PXP',
            },
          ],
        },
      });

      const result = await adapter.purchaseProduct({
        productId: 'chatgpt:plus_1m',
        qty: 1,
        transactionId: 'TX-DAI-20261011-001',
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/api/v1/order',
        {
          product_id: 'chatgpt',
          plan_id: 'plus_1m',
          qty: 1,
        },
        expect.objectContaining({
          headers: { 'Idempotency-Key': 'TX-DAI-20261011-001' },
        })
      );

      expect(result.orderId).toBe('DAI-ORD-88231');
      expect(result.deliveredKeys).toHaveLength(1);
      expect(result.deliveredKeys[0]).toBe(
        'Email: buyer@example.com | Password: secretPassword123 | 2FA: JBSWY3DPEHPK3PXP'
      );
      expect(result.balance.deducted).toBe(18.5);
    });

    it('purchaseProduct clamps quantity between 1 and 50 per DAI specification', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        status: 200,
        data: {
          order_code: 'DAI-ORD-999',
          credentials: [{ email: 'test@ai.com', password: 'pass' }],
        },
      });

      await adapter.purchaseProduct({
        productId: 'chatgpt:plus_1m',
        qty: 100, // over limit of 50
        transactionId: 'TX-DAI-OVERQTY',
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/api/v1/order',
        expect.objectContaining({ qty: 50 }),
        expect.anything()
      );
    });

    it('purchaseProduct throws SupplierRejectedError on 401 Unauthorized', async () => {
      mockAxiosInstance.post.mockRejectedValueOnce({
        response: {
          status: 401,
          data: { detail: 'Missing or Invalid API Key' },
        },
      });

      await expect(
        adapter.purchaseProduct({
          productId: 'chatgpt:plus_1m',
          qty: 1,
          transactionId: 'TX-DAI-401',
        })
      ).rejects.toThrow(SupplierRejectedError);
    });

    it('purchaseProduct throws SupplierRejectedError on 402 Insufficient Balance', async () => {
      mockAxiosInstance.post.mockRejectedValueOnce({
        response: {
          status: 402,
          data: { detail: 'Wallet balance insufficient for this order' },
        },
      });

      await expect(
        adapter.purchaseProduct({
          productId: 'chatgpt:plus_1m',
          qty: 1,
          transactionId: 'TX-DAI-402',
        })
      ).rejects.toThrow(SupplierRejectedError);
    });

    it('purchaseProduct throws SupplierRejectedError on 422 Validation Error', async () => {
      mockAxiosInstance.post.mockRejectedValueOnce({
        response: {
          status: 422,
          data: {
            detail: [{ loc: ['body', 'plan_id'], msg: 'Invalid plan_id for product' }],
          },
        },
      });

      await expect(
        adapter.purchaseProduct({
          productId: 'chatgpt:invalid_plan',
          qty: 1,
          transactionId: 'TX-DAI-422',
        })
      ).rejects.toThrow(SupplierRejectedError);
    });

    it('purchaseProduct throws SupplierFailedRefundedError on 502 Upstream Failure', async () => {
      mockAxiosInstance.post.mockRejectedValueOnce({
        response: {
          status: 502,
          data: { detail: 'Downstream AI account generator unavailable' },
        },
      });

      await expect(
        adapter.purchaseProduct({
          productId: 'chatgpt:plus_1m',
          qty: 1,
          transactionId: 'TX-DAI-502',
        })
      ).rejects.toThrow(SupplierFailedRefundedError);
    });

    it('purchaseProduct throws SupplierUnknownOutcomeError on 500 Internal Error', async () => {
      mockAxiosInstance.post.mockRejectedValueOnce({
        response: {
          status: 500,
          data: { detail: 'Internal Server Error' },
        },
      });

      await expect(
        adapter.purchaseProduct({
          productId: 'chatgpt:plus_1m',
          qty: 1,
          transactionId: 'TX-DAI-500',
        })
      ).rejects.toThrow(SupplierUnknownOutcomeError);
    });

    it('getBalance returns numeric balance from DAI API', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        status: 200,
        data: {
          balance: 85.5,
          currency: 'USD',
          reseller_name: 'VendingLink Admin',
        },
      });

      const balance = await adapter.getBalance();
      expect(balance).toBe(85.5);
    });

    it('findRecentOrder finds completed matching order', async () => {
      const past = new Date(Date.now() - 60000);
      mockAxiosInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [
          {
            order_code: 'DAI-PAST-1',
            product_id: 'chatgpt',
            plan_id: 'plus_1m',
            timestamp: new Date().toISOString(),
            status: 'completed',
            amount: 18.5,
            credentials: [{ email: 'past@ai.com', password: 'pass' }],
          },
        ],
      });

      const found = await adapter.findRecentOrder({
        productId: 'chatgpt:plus_1m',
        qty: 1,
        since: past,
      });

      expect(found).not.toBeNull();
      expect(found?.orderId).toBe('DAI-PAST-1');
      expect(found?.deliveredKeys[0]).toContain('Email: past@ai.com');
    });
  });
});

describe('SupplierFactory Multi-Supplier Registration & Best Offer', () => {
  it('registers RZK, PDA, and DAI adapters in factory', () => {
    const rzk = supplierFactory.getAdapter('RZK');
    const pda = supplierFactory.getAdapter('PDA');
    const dai = supplierFactory.getAdapter('DAI');

    expect(rzk.code).toBe('RZK');
    expect(pda.code).toBe('PDA');
    expect(dai.code).toBe('DAI');
    expect(dai.displayName).toBe('Digital AI Store');

    const list = supplierFactory.listSuppliers();
    const codes = list.map((s) => s.code);
    expect(codes).toContain('RZK');
    expect(codes).toContain('PDA');
    expect(codes).toContain('DAI');
  });

  it('findBestOffer compares across RZK, PDA, and DAI', async () => {
    const mockRzk = {
      code: 'RZK',
      displayName: 'Rezeki Shop',
      getProductList: vi.fn().mockResolvedValue([
        { id: 'rzk_cursor', name: 'Cursor Pro', price: 20.0, availability: 'in_stock', stock: 5 },
      ]),
    };
    const mockPda = {
      code: 'PDA',
      displayName: 'Prime Digital AI',
      getProductList: vi.fn().mockResolvedValue([
        { id: 'pda_cursor', name: 'Cursor Pro', price: 18.0, availability: 'in_stock', stock: 10 },
      ]),
    };
    const mockDai = {
      code: 'DAI',
      displayName: 'Digital AI Store',
      getProductList: vi.fn().mockResolvedValue([
        { id: 'cursor:pro_1m', name: 'Cursor Pro', price: 16.0, availability: 'in_stock', stock: 20 },
      ]),
    };

    const factory = new (supplierFactory.constructor as any)();
    factory.register(mockRzk);
    factory.register(mockPda);
    factory.register(mockDai);

    const bestOffer = await factory.findBestOffer('Cursor');
    expect(bestOffer).not.toBeNull();
    // DAI offered 16.0 vs PDA 18.0 and RZK 20.0 -> DAI wins
    expect(bestOffer?.adapter.code).toBe('DAI');
    expect(bestOffer?.product.price).toBe(16.0);
  });
});
