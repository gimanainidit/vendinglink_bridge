import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { env } from '../config/env';
import { prisma } from '../db';
import { agentGuardrailService } from '../services/agentGuardrailService';
import { productSearchQueue, supplierOrderQueue } from '../queues/queues';

vi.mock('../queues/queues', () => ({
  productSearchQueue: {
    add: vi.fn().mockResolvedValue({ id: 'job_123' }),
  },
  supplierOrderQueue: {
    add: vi.fn().mockResolvedValue({ id: 'job_456' }),
  },
  vendingDeliveryQueue: {
    add: vi.fn().mockResolvedValue({ id: 'job_789' }),
  },
  supplierReconcileQueue: {
    add: vi.fn().mockResolvedValue({ id: 'job_000' }),
  },
}));

vi.mock('../services/orchestrator', () => ({
  createPendingTransaction: vi.fn().mockResolvedValue({
    id: 'tx_local_123',
    transactionId: 'BRG-20261011-P2A001',
    status: 'PENDING',
  }),
}));

describe('P2a Agentic Purchasing & Guardrail Tests', () => {
  const app = createApp();
  const validSecret = env.BRIDGE_SECRET_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    agentGuardrailService.setPaused(false);
  });

  describe('Agent Guardrail Evaluation', () => {
    it('rejects when emergency kill switch is paused via /agent pause', async () => {
      agentGuardrailService.setPaused(true);
      const res = await agentGuardrailService.evaluateGuardrail({
        quotedPrice: 50000,
        supplierCode: 'RZK',
      });

      expect(res.allowed).toBe(false);
      expect(res.reason).toContain('emergency kill switch');
    });

    it('rejects suppliers not in AGENT_ALLOWED_SUPPLIER_CODES allowlist', async () => {
      const res = await agentGuardrailService.evaluateGuardrail({
        quotedPrice: 50000,
        supplierCode: 'UNKNOWN_SUPPLIER',
      });

      expect(res.allowed).toBe(false);
      expect(res.reason).toContain('not in AGENT_ALLOWED_SUPPLIER_CODES');
    });

    it('rejects when quoted price exceeds AGENT_MAX_SPEND_PER_REQUEST', async () => {
      const res = await agentGuardrailService.evaluateGuardrail({
        quotedPrice: env.AGENT_MAX_SPEND_PER_REQUEST + 1000,
        supplierCode: 'RZK',
      });

      expect(res.allowed).toBe(false);
      expect(res.reason).toContain('exceeds AGENT_MAX_SPEND_PER_REQUEST');
    });

    it('flags requiresManualConfirm for high value purchases', async () => {
      vi.spyOn(agentGuardrailService, 'getSettings').mockReturnValueOnce({
        enabled: true,
        paused: false,
        maxSpendPerRequest: 500000,
        maxSpendPerDay: 5000000,
        minBalanceFloor: 200000,
        allowedSuppliers: ['RZK', 'PDA', 'DAI'],
        highValueThreshold: 300000,
      });

      const res = await agentGuardrailService.evaluateGuardrail({
        quotedPrice: 350000,
        supplierCode: 'RZK',
      });

      expect(res.allowed).toBe(true);
      expect(res.requiresManualConfirm).toBe(true);
    });
  });

  describe('HTTP Inbound Endpoints (/api/v1/requests)', () => {
    it('requires Bearer token authentication', async () => {
      const res = await request(app)
        .post('/api/v1/requests')
        .send({ customerRef: 'cust_1', query: 'Canva Pro' });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });

    it('requires Idempotency-Key header', async () => {
      const res = await request(app)
        .post('/api/v1/requests')
        .set('Authorization', `Bearer ${validSecret}`)
        .send({ customerRef: 'cust_1', query: 'Canva Pro' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Idempotency-Key');
    });

    it('creates a new ProductRequest and enqueues search job', async () => {
      const idempotencyKey = `test-idem-${Date.now()}`;
      const res = await request(app)
        .post('/api/v1/requests')
        .set('Authorization', `Bearer ${validSecret}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          customerRef: 'cust_101',
          query: 'ChatGPT Plus 1 Bulan',
          categorySlug: 'ai-tools',
          maxBudget: 350000,
        });

      expect(res.status).toBe(202);
      expect(res.body.requestId).toBeDefined();
      expect(res.body.status).toBe('SEARCHING');
      expect(productSearchQueue.add).toHaveBeenCalled();

      // Verify idempotent replay
      const replay = await request(app)
        .post('/api/v1/requests')
        .set('Authorization', `Bearer ${validSecret}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          customerRef: 'cust_101',
          query: 'ChatGPT Plus 1 Bulan',
        });

      expect(replay.status).toBe(200);
      expect(replay.body.requestId).toBe(res.body.requestId);
    });

    it('retrieves ProductRequest details by ID', async () => {
      const reqRecord = await prisma.productRequest.create({
        data: {
          idempotencyKey: `get-test-${Date.now()}`,
          customerRef: 'cust_202',
          query: 'Cursor AI Pro',
          status: 'FOUND',
          foundSupplierCode: 'DAI',
          foundProductId: 'cursor:pro_1m',
          quotedPrice: 16.0,
        },
      });

      const res = await request(app)
        .get(`/api/v1/requests/${reqRecord.id}`)
        .set('Authorization', `Bearer ${validSecret}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('FOUND');
      expect(res.body.foundSupplierCode).toBe('DAI');
      expect(res.body.quotedPrice).toBe(16.0);
    });

    it('confirms a FOUND ProductRequest and triggers immediate purchase order', async () => {
      const reqRecord = await prisma.productRequest.create({
        data: {
          idempotencyKey: `confirm-test-${Date.now()}`,
          customerRef: 'cust_303',
          query: 'Canva Pro Invite',
          status: 'FOUND',
          foundSupplierCode: 'PDA',
          foundProductId: 'pda_canva',
          quotedPrice: 1.5,
        },
      });

      const res = await request(app)
        .post(`/api/v1/requests/${reqRecord.id}/confirm`)
        .set('Authorization', `Bearer ${validSecret}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CONFIRMED');
      expect(res.body.transactionId).toBe('BRG-20261011-P2A001');
      expect(supplierOrderQueue.add).toHaveBeenCalled();

      const updated = await prisma.productRequest.findUnique({ where: { id: reqRecord.id } });
      expect(updated?.status).toBe('CONFIRMED');
      expect(updated?.transactionId).toBe('BRG-20261011-P2A001');
    });

    it('rejects confirmation if request is not in FOUND state', async () => {
      const searchingReq = await prisma.productRequest.create({
        data: {
          idempotencyKey: `reject-confirm-${Date.now()}`,
          customerRef: 'cust_404',
          query: 'Searching Item',
          status: 'SEARCHING',
        },
      });

      const res = await request(app)
        .post(`/api/v1/requests/${searchingReq.id}/confirm`)
        .set('Authorization', `Bearer ${validSecret}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Only 'FOUND' requests can be confirmed");
    });
  });
});
