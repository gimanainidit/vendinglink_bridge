import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { env } from '../config/env';
import { prisma } from '../db';
import { encryptCredentials } from '../lib/crypto';
import { adapterBuildService } from '../services/adapterBuildService';
import { bot } from '../telegram/bot';

describe('Hermes Agent Adapter Builder Pipeline (BR-P2b-6)', () => {
  const app = createApp();
  const validSecret = env.HERMES_API_SECRET;
  const bridgeSecret = env.BRIDGE_SECRET_KEY;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(bot.telegram, 'sendMessage').mockResolvedValue({} as any);

    // Clean up test records
    await prisma.adapterBuildJob.deleteMany({
      where: { supplierCode: 'TEST_BUILDER' },
    });
    await prisma.supplier.deleteMany({
      where: { code: 'TEST_BUILDER' },
    });

    // Seed a supplier with valid encrypted credentials
    await prisma.supplier.create({
      data: {
        code: 'TEST_BUILDER',
        displayName: 'Test Builder Supplier',
        baseUrl: 'https://api.builder-test.com',
        authType: 'API_KEY',
        credentialsEnc: encryptCredentials({ apiKey: 'super_secret_test_key_99999' }),
        descriptor: JSON.stringify({
          endpoints: {
            balance: { path: '/v1/my-balance' },
          },
        }),
        status: 'NEEDS_REVIEW',
      },
    });
  });

  describe('Triggering Adapter Build Job', () => {
    it('creates a build job with sanitized spec via POST /api/v1/suppliers/:code/build-adapter', async () => {
      const res = await request(app)
        .post('/api/v1/suppliers/TEST_BUILDER/build-adapter')
        .set('Authorization', `Bearer ${bridgeSecret}`);

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.job).toHaveProperty('id');
      expect(res.body.job.status).toBe('QUEUED');

      // Verify spec in database is sanitized (mocked, no real secret)
      const job = await prisma.adapterBuildJob.findUnique({
        where: { id: res.body.job.id },
      });
      expect(job).not.toBeNull();
      expect(job?.sanitizedSpec).toContain('<MOCK_API_KEY>');
      expect(job?.sanitizedSpec).not.toContain('super_secret_test_key_99999');

      // Verify telegram notification was sent
      expect(bot.telegram.sendMessage).toHaveBeenCalled();
    });

    it('returns existing job if already queued', async () => {
      const first = await adapterBuildService.createBuildJob('TEST_BUILDER');
      expect(first.queued).toBe(true);

      const second = await adapterBuildService.createBuildJob('TEST_BUILDER');
      expect(second.queued).toBe(true);
      expect(second.job.id).toBe(first.job.id);
    });
  });

  describe('Hermes Runner Ingress API (/api/v1/hermes/build-jobs)', () => {
    it('lists pending queued jobs for Hermes runner', async () => {
      await adapterBuildService.createBuildJob('TEST_BUILDER');

      const res = await request(app)
        .get('/api/v1/hermes/build-jobs/pending')
        .set('Authorization', `Bearer ${validSecret}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('jobs');
      expect(Array.isArray(res.body.jobs)).toBe(true);

      const found = res.body.jobs.find((j: any) => j.supplierCode === 'TEST_BUILDER');
      expect(found).toBeDefined();
      expect(found.status).toBe('QUEUED');
      expect(found.spec.sanitizedCredentials.apiKey).toBe('<MOCK_API_KEY>');
    });

    it('updates job status to PR_CREATED with draft PR URL and notifies admin', async () => {
      const { job } = await adapterBuildService.createBuildJob('TEST_BUILDER');

      const prUrl = 'https://github.com/gimanainidit/vendinglink_bridge/pull/999';
      const branchName = 'feat/adapter-test-builder';

      const res = await request(app)
        .patch(`/api/v1/hermes/build-jobs/${job.id}`)
        .set('Authorization', `Bearer ${validSecret}`)
        .send({
          status: 'PR_CREATED',
          prUrl,
          branchName,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.job.status).toBe('PR_CREATED');
      expect(res.body.job.prUrl).toBe(prUrl);

      const updated = await prisma.adapterBuildJob.findUnique({ where: { id: job.id } });
      expect(updated?.status).toBe('PR_CREATED');
      expect(updated?.prUrl).toBe(prUrl);

      // Verify telegram notification with PR link was dispatched
      expect(bot.telegram.sendMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining(prUrl),
        expect.anything()
      );
    });

    it('updates job status to FAILED with error message', async () => {
      const { job } = await adapterBuildService.createBuildJob('TEST_BUILDER');

      const res = await request(app)
        .patch(`/api/v1/hermes/build-jobs/${job.id}`)
        .set('Authorization', `Bearer ${validSecret}`)
        .send({
          status: 'FAILED',
          error: 'Vitest mock tests failed in sandbox',
        });

      expect(res.status).toBe(200);
      expect(res.body.job.status).toBe('FAILED');
      expect(res.body.job.error).toContain('Vitest mock tests failed');
    });
  });
});
