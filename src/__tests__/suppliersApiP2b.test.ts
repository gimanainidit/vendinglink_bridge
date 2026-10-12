import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { env } from '../config/env';
import { prisma } from '../db';
import { supplierValidationService } from '../services/supplierValidationService';
import { parseCommand } from '../telegram/parser/commandParser';

describe('P2b Dynamic Suppliers Ingress API & Telegram Commands', () => {
  const app = createApp();
  const validSecret = env.BRIDGE_SECRET_KEY;

  beforeEach(async () => {
    vi.clearAllMocks();
  });

  describe('Authentication & Ingress Security', () => {
    it('rejects GET /api/v1/suppliers without auth header', async () => {
      const res = await request(app).get('/api/v1/suppliers');
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });

    it('rejects POST /api/v1/suppliers with invalid token', async () => {
      const res = await request(app)
        .post('/api/v1/suppliers')
        .set('Authorization', 'Bearer WRONG_TOKEN')
        .send({
          code: 'TEST',
          displayName: 'Test',
          baseUrl: 'https://api.test.com',
          credentials: { key: '123' },
          descriptor: {},
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Invalid secret key');
    });
  });

  describe('CRUD Operations on /api/v1/suppliers', () => {
    const testCode = 'SUP_TEST_01';

    const testDescriptor = {
      version: '1.0',
      auth: { type: 'API_KEY', headerName: 'X-API-KEY' },
      endpoints: {
        balance: { path: '/v1/balance', responsePath: 'data.balance' },
        productList: { path: '/v1/products', responsePath: 'data' },
      },
    };

    it('registers a new supplier and executes dry-run validation', async () => {
      // Mock validation to succeed
      vi.spyOn(supplierValidationService, 'validateSupplier').mockResolvedValueOnce({
        success: true,
        code: testCode,
        balance: 1000000,
        productCount: 15,
        checkedAt: new Date().toISOString(),
      });

      const res = await request(app)
        .post('/api/v1/suppliers')
        .set('Authorization', `Bearer ${validSecret}`)
        .send({
          code: testCode,
          displayName: 'Supplier Testing Dynamic',
          baseUrl: 'https://supplier-test.example.com',
          authType: 'API_KEY',
          credentials: { apiKey: 'super-secret-api-key' },
          descriptor: testDescriptor,
          validateImmediately: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.supplier).toBeDefined();
      expect(res.body.supplier.code).toBe(testCode);
      expect(res.body.supplier.credentialsMasked).toBe('••••••••');
      expect(res.body.supplier.credentialsEnc).toBeUndefined(); // Never leaked!
      expect(res.body.validation).toBeDefined();
      expect(res.body.validation.success).toBe(true);

      // Verify DB record has encrypted credentials
      const dbRow = await prisma.supplier.findUnique({ where: { code: testCode } });
      expect(dbRow).not.toBeNull();
      expect(dbRow!.credentialsEnc).toContain(':'); // iv:authTag:cipher
      expect(dbRow!.credentialsEnc).not.toContain('super-secret-api-key');
    });

    it('lists registered suppliers with masked credentials', async () => {
      const res = await request(app)
        .get('/api/v1/suppliers')
        .set('Authorization', `Bearer ${validSecret}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.suppliers)).toBe(true);
      expect(res.body.builtIns).toBeDefined();

      const found = res.body.suppliers.find((s: any) => s.code === testCode);
      expect(found).toBeDefined();
      expect(found.credentialsMasked).toBe('••••••••');
      expect(found.credentialsEnc).toBeUndefined();
    });

    it('fetches single supplier by code', async () => {
      const res = await request(app)
        .get(`/api/v1/suppliers/${testCode}`)
        .set('Authorization', `Bearer ${validSecret}`);

      expect(res.status).toBe(200);
      expect(res.body.supplier.code).toBe(testCode);
      expect(res.body.supplier.displayName).toBe('Supplier Testing Dynamic');
    });

    it('updates supplier status to PAUSED via PATCH', async () => {
      const res = await request(app)
        .patch(`/api/v1/suppliers/${testCode}`)
        .set('Authorization', `Bearer ${validSecret}`)
        .send({
          status: 'PAUSED',
        });

      expect(res.status).toBe(200);
      expect(res.body.supplier.status).toBe('PAUSED');

      const dbRow = await prisma.supplier.findUnique({ where: { code: testCode } });
      expect(dbRow!.status).toBe('PAUSED');
    });

    it('triggers on-demand dry-run validation', async () => {
      vi.spyOn(supplierValidationService, 'validateSupplier').mockResolvedValueOnce({
        success: false,
        code: testCode,
        error: 'Connection timed out',
        checkedAt: new Date().toISOString(),
      });

      const res = await request(app)
        .post(`/api/v1/suppliers/${testCode}/validate`)
        .set('Authorization', `Bearer ${validSecret}`);

      expect(res.status).toBe(200);
      expect(res.body.validation.success).toBe(false);
      expect(res.body.validation.error).toBe('Connection timed out');
    });

    // Cleanup
    afterAll(async () => {
      await prisma.supplier.deleteMany({ where: { code: testCode } });
    });
  });

  describe('Telegram /suppliers Command Parser', () => {
    it('parses /suppliers with no args', () => {
      const parsed = parseCommand('/suppliers');
      expect(parsed.command).toEqual({
        type: 'suppliers',
        supplierCode: undefined,
      });
    });

    it('parses /suppliers with specific code', () => {
      const parsed = parseCommand('/suppliers DGF');
      expect(parsed.command).toEqual({
        type: 'suppliers',
        supplierCode: 'DGF',
      });
    });
  });
});
