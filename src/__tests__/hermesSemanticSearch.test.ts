import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateLocalSimilarity, normalizePriceToIdr, matchBestOffer } from '../services/hermesSemanticMatcher';
import { retrieveCandidates } from '../suppliers/candidateRetriever';
import { ISupplierAdapter } from '../suppliers/ISupplierAdapter';
import { Product } from '../suppliers/types';

describe('Hermes Semantic Matcher & Candidate Retrieval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('normalizePriceToIdr', () => {
    it('should return raw price if currency is IDR or missing', () => {
      expect(normalizePriceToIdr(5000, 'IDR')).toBe(5000);
      expect(normalizePriceToIdr(10, undefined)).toBe(10);
    });

    it('should convert USD to IDR at rate 16000', () => {
      expect(normalizePriceToIdr(1.5, 'USD')).toBe(24000);
      expect(normalizePriceToIdr(0.1, 'USD')).toBe(1600);
    });

    it('should handle undefined or null price gracefully', () => {
      expect(normalizePriceToIdr(undefined, 'IDR')).toBe(0);
      expect(normalizePriceToIdr(null, 'USD')).toBe(0);
    });
  });

  describe('calculateLocalSimilarity', () => {
    it('should match test products to Test Api product with high score', () => {
      const score = calculateLocalSimilarity('test products', 'Test Api product');
      expect(score).toBeGreaterThanOrEqual(50);
    });

    it('should match duolingo to Duolingo Super 12M', () => {
      const score = calculateLocalSimilarity('duolingo', 'Duolingo Super 12M');
      expect(score).toBe(100);
    });

    it('should score zero for completely unrelated strings', () => {
      const score = calculateLocalSimilarity('netflix', 'Canva Pro Admin');
      expect(score).toBe(0);
    });
  });

  describe('retrieveCandidates', () => {
    it('should retrieve and deduplicate candidates using multi-token queries', async () => {
      const mockAdapter: ISupplierAdapter = {
        code: 'TEST',
        displayName: 'Test Supplier',
        getBalance: vi.fn().mockResolvedValue(100000),
        getProductList: vi.fn().mockImplementation((search?: string) => {
          if (search === 'test' || !search) {
            return Promise.resolve([
              {
                id: 'p1',
                name: 'Test Api product',
                price: 1,
                availability: 'in_stock',
              } as Product,
            ]);
          }
          return Promise.resolve([]);
        }),
        getProduct: vi.fn(),
        purchase: vi.fn(),
        healthCheck: vi.fn(),
      };

      const candidates = await retrieveCandidates([mockAdapter], 'test products');
      expect(candidates.length).toBe(1);
      expect(candidates[0].product.name).toBe('Test Api product');
      expect(candidates[0].supplierCode).toBe('TEST');
    });
  });

  describe('matchBestOffer', () => {
    const mockAdapter: ISupplierAdapter = {
      code: 'RZK',
      displayName: 'Rezeki Shop',
      getBalance: vi.fn(),
      getProductList: vi.fn(),
      getProduct: vi.fn(),
      purchase: vi.fn(),
      healthCheck: vi.fn(),
    };

    const candidates = [
      {
        adapter: mockAdapter,
        supplierCode: 'RZK',
        product: {
          id: 'loc_test1',
          name: 'Test Api product',
          price: 1,
          availability: 'in_stock' as const,
        },
      },
      {
        adapter: mockAdapter,
        supplierCode: 'RZK',
        product: {
          id: 'unrelated',
          name: 'Streaming 30D',
          price: 50000,
          availability: 'in_stock' as const,
        },
      },
    ];

    it('should match "test products" to "Test Api product" within budget', async () => {
      const result = await matchBestOffer('test products', candidates, 10);
      expect(result.matched).toBe(true);
      expect(result.candidate?.product.id).toBe('loc_test1');
      expect(result.confidence).toBeGreaterThanOrEqual(50);
    });

    it('should reject if best candidate exceeds maxBudget', async () => {
      const result = await matchBestOffer('test products', candidates, 0.5);
      expect(result.matched).toBe(false);
      expect(result.reason).toContain('budget');
    });

    it('should return unmatched if no candidate meets similarity threshold', async () => {
      const result = await matchBestOffer('xyzunknown123', candidates, 100);
      expect(result.matched).toBe(false);
    });
  });
});
