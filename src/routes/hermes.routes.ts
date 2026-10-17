import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { prisma } from '../db';
import { agentGuardrailService } from '../services/agentGuardrailService';
import { adapterBuildService } from '../services/adapterBuildService';
import { supplierFactory } from '../suppliers/SupplierFactory';
import { logger } from '../lib/logger';

export const hermesRouter = Router();

// Internal Bearer Auth Middleware for Hermes loopback
export const hermesAuthMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing or invalid Bearer token' });
    return;
  }

  const token = authHeader.split(' ')[1];
  const cleanToken = token ? token.replace(/^["']|["']$/g, '').trim() : '';
  const cleanHermesSecret = env.HERMES_API_SECRET?.replace(/^["']|["']$/g, '').trim();
  const cleanBridgeSecret = env.BRIDGE_SECRET_KEY?.replace(/^["']|["']$/g, '').trim();
  const isValid = Boolean(cleanToken) && (cleanToken === cleanHermesSecret || cleanToken === cleanBridgeSecret);

  if (!isValid) {
    logger.warn({ ip: req.ip }, 'Invalid Hermes API secret attempt');
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
    return;
  }

  next();
};

hermesRouter.use(hermesAuthMiddleware);

const updateHermesConfigSchema = z.object({
  maxSpendPerRequest: z.number().positive().optional(),
  maxSpendPerDay: z.number().positive().optional(),
  minBalanceFloor: z.number().nonnegative().optional(),
  priceDeltaAlertPct: z.number().positive().optional(),
  highValueThreshold: z.number().positive().optional(),
  isAgentEnabled: z.boolean().optional(),
  updatedBy: z.string().default('hermes-agent'),
});

/**
 * GET /api/v1/hermes/telemetry
 * Returns operational limits, real-time spending, request counters, and supplier balances.
 */
hermesRouter.get('/telemetry', async (req: Request, res: Response) => {
  try {
    const config = await agentGuardrailService.getOperationalConfig();
    const settings = agentGuardrailService.getSettings();

    // 1. Daily spend calculation
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todaySpendAgg = await prisma.transaction.aggregate({
      where: {
        createdAt: { gte: todayStart },
        status: { in: ['COMPLETED', 'SUPPLIER_OK', 'VENDING_RETRY'] },
      },
      _sum: { totalPrice: true },
      _count: { id: true },
    });

    const totalSpentToday = todaySpendAgg._sum.totalPrice || 0;
    const effectiveDailyCap = settings.maxSpendPerDay;
    const remainingDailySpend = Math.max(0, effectiveDailyCap - totalSpentToday);

    // 2. Request stats in last 24h
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const requestsGroup = await prisma.productRequest.groupBy({
      by: ['status'],
      where: { createdAt: { gte: last24h } },
      _count: { id: true },
    });

    const requestStats: Record<string, number> = {
      SEARCHING: 0,
      FOUND: 0,
      NOT_FOUND: 0,
      CONFIRMED: 0,
      PURCHASED: 0,
      EXPIRED: 0,
      REJECTED: 0,
    };
    for (const item of requestsGroup) {
      requestStats[item.status] = item._count.id;
    }

    // 3. Supplier balances
    const adapters = supplierFactory.getAllAdapters();
    const balanceResults = await Promise.allSettled(
      adapters.map(async (adapter) => {
        try {
          const balance = await adapter.getBalance();
          return {
            code: adapter.code,
            displayName: adapter.displayName,
            balance,
            status: 'AVAILABLE',
          };
        } catch (err: any) {
          return {
            code: adapter.code,
            displayName: adapter.displayName,
            balance: null,
            status: 'ERROR',
            error: err.message,
          };
        }
      })
    );

    const supplierBalances = balanceResults.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            code: adapters[i].code,
            displayName: adapters[i].displayName,
            balance: null,
            status: 'ERROR',
            error: (r as PromiseRejectedResult).reason?.message,
          }
    );

    res.status(200).json({
      timestamp: new Date().toISOString(),
      agentStatus: {
        enabled: settings.enabled,
        paused: settings.paused,
      },
      limits: {
        layer1HardCeilings: {
          maxSpendPerRequest: env.AGENT_MAX_SPEND_PER_REQUEST,
          maxSpendPerDay: env.AGENT_MAX_SPEND_PER_DAY,
          minBalanceFloor: env.AGENT_MIN_BALANCE_FLOOR,
          highValueThreshold: env.AGENT_HIGH_VALUE_THRESHOLD,
        },
        layer2OperationalConfig: config,
        effectiveLimits: {
          maxSpendPerRequest: settings.maxSpendPerRequest,
          maxSpendPerDay: settings.maxSpendPerDay,
          minBalanceFloor: settings.minBalanceFloor,
          highValueThreshold: settings.highValueThreshold,
        },
      },
      spending: {
        todayTotal: totalSpentToday,
        transactionCount: todaySpendAgg._count.id,
        remainingDailyLimit: remainingDailySpend,
        utilizationPct: effectiveDailyCap > 0 ? (totalSpentToday / effectiveDailyCap) * 100 : 0,
      },
      requestStats24h: requestStats,
      suppliers: supplierBalances,
    });
  } catch (err: any) {
    logger.error({ err }, 'Error building Hermes telemetry');
    res.status(500).json({ error: 'Internal server error gathering telemetry' });
  }
});

/**
 * PATCH /api/v1/hermes/config
 * Updates Layer 2 dynamic operational config after HITL approval.
 * Hard ceilings from Layer 1 (env) cannot be exceeded.
 */
hermesRouter.patch('/config', async (req: Request, res: Response) => {
  try {
    const parseResult = updateHermesConfigSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: 'Invalid request body', details: parseResult.error.format() });
      return;
    }

    const payload = parseResult.data;

    // Enforce Layer 1 absolute hard ceilings
    if (payload.maxSpendPerRequest !== undefined && payload.maxSpendPerRequest > env.AGENT_MAX_SPEND_PER_REQUEST) {
      res.status(400).json({
        error: `Requested maxSpendPerRequest (${payload.maxSpendPerRequest}) exceeds Layer 1 hard ceiling (${env.AGENT_MAX_SPEND_PER_REQUEST})`,
      });
      return;
    }

    if (payload.maxSpendPerDay !== undefined && payload.maxSpendPerDay > env.AGENT_MAX_SPEND_PER_DAY) {
      res.status(400).json({
        error: `Requested maxSpendPerDay (${payload.maxSpendPerDay}) exceeds Layer 1 hard ceiling (${env.AGENT_MAX_SPEND_PER_DAY})`,
      });
      return;
    }

    const updated = await prisma.agentOperationalConfig.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        maxSpendPerRequest: payload.maxSpendPerRequest ?? env.AGENT_MAX_SPEND_PER_REQUEST,
        maxSpendPerDay: payload.maxSpendPerDay ?? env.AGENT_MAX_SPEND_PER_DAY,
        minBalanceFloor: payload.minBalanceFloor ?? env.AGENT_MIN_BALANCE_FLOOR,
        priceDeltaAlertPct: payload.priceDeltaAlertPct ?? env.AGENT_PRICE_DELTA_ALERT_PCT,
        highValueThreshold: payload.highValueThreshold ?? env.AGENT_HIGH_VALUE_THRESHOLD,
        isAgentEnabled: payload.isAgentEnabled ?? env.AGENT_ENABLED,
        updatedBy: payload.updatedBy,
        approvedAt: new Date(),
      },
      update: {
        ...(payload.maxSpendPerRequest !== undefined && { maxSpendPerRequest: payload.maxSpendPerRequest }),
        ...(payload.maxSpendPerDay !== undefined && { maxSpendPerDay: payload.maxSpendPerDay }),
        ...(payload.minBalanceFloor !== undefined && { minBalanceFloor: payload.minBalanceFloor }),
        ...(payload.priceDeltaAlertPct !== undefined && { priceDeltaAlertPct: payload.priceDeltaAlertPct }),
        ...(payload.highValueThreshold !== undefined && { highValueThreshold: payload.highValueThreshold }),
        ...(payload.isAgentEnabled !== undefined && { isAgentEnabled: payload.isAgentEnabled }),
        updatedBy: payload.updatedBy,
        approvedAt: new Date(),
      },
    });

    if (payload.isAgentEnabled !== undefined) {
      await agentGuardrailService.setPaused(!payload.isAgentEnabled, payload.updatedBy);
    }

    logger.info({ updatedBy: payload.updatedBy, config: updated }, 'Hermes updated Layer 2 operational config');

    res.status(200).json({
      success: true,
      message: 'AgentOperationalConfig updated successfully',
      config: updated,
    });
  } catch (err: any) {
    logger.error({ err }, 'Error updating Hermes operational config');
    res.status(500).json({ error: 'Internal server error updating configuration' });
  }
});

const updateBuildJobSchema = z.object({
  status: z.enum(['PROCESSING', 'PR_CREATED', 'FAILED']),
  prUrl: z.string().url().optional(),
  branchName: z.string().optional(),
  error: z.string().optional(),
});

/**
 * GET /api/v1/hermes/build-jobs/pending
 * Hermes Runner polls this endpoint to fetch queued adapter builder tasks.
 */
hermesRouter.get('/build-jobs/pending', async (req: Request, res: Response) => {
  try {
    const jobs = await adapterBuildService.getPendingJobs();
    const formatted = jobs.map((j) => {
      let parsedSpec = {};
      try {
        parsedSpec = JSON.parse(j.sanitizedSpec);
      } catch {
        parsedSpec = { raw: j.sanitizedSpec };
      }
      return {
        id: j.id,
        supplierCode: j.supplierCode,
        status: j.status,
        spec: parsedSpec,
        createdAt: j.createdAt,
      };
    });

    res.status(200).json({ jobs: formatted });
  } catch (err: any) {
    logger.error({ err }, 'Error fetching pending build jobs');
    res.status(500).json({ error: 'Failed to fetch pending build jobs' });
  }
});

/**
 * PATCH /api/v1/hermes/build-jobs/:id
 * Hermes Runner reports the build status, Draft PR URL, or error details.
 */
hermesRouter.patch('/build-jobs/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const parseResult = updateBuildJobSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Invalid build job update payload',
      details: parseResult.error.format(),
    });
  }

  try {
    const updated = await adapterBuildService.updateJobStatus(id, parseResult.data);
    res.status(200).json({
      success: true,
      message: `Build job ${id} updated to ${updated.status}`,
      job: updated,
    });
  } catch (err: any) {
    if (err.message.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    logger.error({ err, id }, 'Error updating build job status');
    res.status(500).json({ error: `Failed to update build job: ${err.message}` });
  }
});

/**
 * POST /api/v1/hermes/evaluate-query
 * Endpoint for Hermes Agent to test and verify semantic product matching.
 */
hermesRouter.post('/evaluate-query', async (req: Request, res: Response) => {
  const { query, maxBudget } = req.body;
  if (!query) {
    res.status(400).json({ error: 'Query is required' });
    return;
  }

  try {
    const offer = await supplierFactory.findBestOffer(String(query), maxBudget ? Number(maxBudget) : undefined);
    if (!offer) {
      res.status(200).json({
        matched: false,
        message: 'No matching in-stock offer found within budget',
      });
      return;
    }

    res.status(200).json({
      matched: true,
      supplierCode: offer.adapter.code,
      productId: offer.product.id,
      productName: offer.product.name,
      price: offer.product.price,
      currency: offer.product.currency,
      confidence: offer.confidence,
      reason: offer.reason,
    });
  } catch (err: any) {
    logger.error({ err }, 'Error evaluating Hermes query');
    res.status(500).json({ error: err.message });
  }
});


