import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { env } from '../config/env';
import { prisma } from '../db';
import { agentGuardrailService } from '../services/agentGuardrailService';
import { runBalanceMonitor } from '../services/balanceMonitorService';
import { supplierFactory } from '../suppliers/SupplierFactory';

describe('Hermes Agent Integration & Telemetry API', () => {
  const app = createApp();
  const validSecret = env.HERMES_API_SECRET;

  beforeEach(async () => {
    vi.clearAllMocks();
    await agentGuardrailService.setPaused(false);
    // Reset DB config to default
    await prisma.agentOperationalConfig.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        maxSpendPerRequest: 500000,
        maxSpendPerDay: 5000000,
        minBalanceFloor: 200000,
        priceDeltaAlertPct: 20,
        highValueThreshold: 1000000,
        isAgentEnabled: true,
        updatedBy: 'test-seed',
      },
      update: {
        maxSpendPerRequest: 500000,
        maxSpendPerDay: 5000000,
        minBalanceFloor: 200000,
        priceDeltaAlertPct: 20,
        highValueThreshold: 1000000,
        isAgentEnabled: true,
        updatedBy: 'test-reset',
      },
    });
  });

  describe('GET /api/v1/hermes/telemetry', () => {
    it('rejects requests without Bearer authorization', async () => {
      const res = await request(app).get('/api/v1/hermes/telemetry');
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
    });

    it('rejects requests with invalid Bearer token', async () => {
      const res = await request(app)
        .get('/api/v1/hermes/telemetry')
        .set('Authorization', 'Bearer invalid-token');
      expect(res.status).toBe(401);
    });

    it('returns structured telemetry when authorized with HERMES_API_SECRET', async () => {
      const res = await request(app)
        .get('/api/v1/hermes/telemetry')
        .set('Authorization', `Bearer ${validSecret}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('timestamp');
      expect(res.body).toHaveProperty('agentStatus');
      expect(res.body.agentStatus.enabled).toBe(true);
      expect(res.body.agentStatus.paused).toBe(false);

      expect(res.body).toHaveProperty('limits');
      expect(res.body.limits).toHaveProperty('layer1HardCeilings');
      expect(res.body.limits.layer1HardCeilings.maxSpendPerRequest).toBe(env.AGENT_MAX_SPEND_PER_REQUEST);

      expect(res.body).toHaveProperty('spending');
      expect(res.body.spending).toHaveProperty('todayTotal');
      expect(res.body.spending).toHaveProperty('remainingDailyLimit');

      expect(res.body).toHaveProperty('requestStats24h');
      expect(res.body).toHaveProperty('suppliers');
      expect(Array.isArray(res.body.suppliers)).toBe(true);
    });
  });

  describe('PATCH /api/v1/hermes/config', () => {
    it('rejects requests exceeding Layer 1 hard ceiling for per-request cap', async () => {
      const res = await request(app)
        .patch('/api/v1/hermes/config')
        .set('Authorization', `Bearer ${validSecret}`)
        .send({
          maxSpendPerRequest: env.AGENT_MAX_SPEND_PER_REQUEST + 50000,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('exceeds Layer 1 hard ceiling');
    });

    it('rejects requests exceeding Layer 1 hard ceiling for daily cap', async () => {
      const res = await request(app)
        .patch('/api/v1/hermes/config')
        .set('Authorization', `Bearer ${validSecret}`)
        .send({
          maxSpendPerDay: env.AGENT_MAX_SPEND_PER_DAY + 100000,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('exceeds Layer 1 hard ceiling');
    });

    it('successfully updates Layer 2 operational limits within bounds', async () => {
      const res = await request(app)
        .patch('/api/v1/hermes/config')
        .set('Authorization', `Bearer ${validSecret}`)
        .send({
          maxSpendPerRequest: 400000,
          maxSpendPerDay: 4000000,
          highValueThreshold: 300000,
          updatedBy: 'hermes-agent-test',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.config.maxSpendPerRequest).toBe(400000);
      expect(res.body.config.maxSpendPerDay).toBe(4000000);
      expect(res.body.config.highValueThreshold).toBe(300000);

      // Verify guardrail service now enforces new per-request cap (400.000)
      const guardrailRes = await agentGuardrailService.evaluateGuardrail({
        quotedPrice: 450000,
        supplierCode: 'RZK',
      });
      expect(guardrailRes.allowed).toBe(false);
      expect(guardrailRes.reason).toContain('exceeds AGENT_MAX_SPEND_PER_REQUEST ceiling (400000)');
    });

    it('toggles agent pause/resume status via isAgentEnabled', async () => {
      // Pause
      const pauseRes = await request(app)
        .patch('/api/v1/hermes/config')
        .set('Authorization', `Bearer ${validSecret}`)
        .send({
          isAgentEnabled: false,
          updatedBy: 'hermes-pause-test',
        });

      expect(pauseRes.status).toBe(200);
      expect(pauseRes.body.config.isAgentEnabled).toBe(false);
      expect(agentGuardrailService.isPaused()).toBe(true);

      const checkPaused = await agentGuardrailService.evaluateGuardrail({
        quotedPrice: 10000,
        supplierCode: 'RZK',
      });
      expect(checkPaused.allowed).toBe(false);

      // Resume
      const resumeRes = await request(app)
        .patch('/api/v1/hermes/config')
        .set('Authorization', `Bearer ${validSecret}`)
        .send({
          isAgentEnabled: true,
          updatedBy: 'hermes-resume-test',
        });

      expect(resumeRes.status).toBe(200);
      expect(resumeRes.body.config.isAgentEnabled).toBe(true);
      expect(agentGuardrailService.isPaused()).toBe(false);
    });
  });

  describe('runBalanceMonitor Service', () => {
    it('executes balance monitor across active adapters without throwing', async () => {
      await expect(runBalanceMonitor()).resolves.not.toThrow();
    });
  });
});
