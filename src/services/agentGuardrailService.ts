import { env } from '../config/env';
import { prisma } from '../db';
import { logger } from '../lib/logger';

// In-memory cache for fast evaluation and test compatibility
let isAgentPausedRuntime = false;
let cachedConfig: {
  maxSpendPerRequest: number;
  maxSpendPerDay: number;
  minBalanceFloor: number;
  priceDeltaAlertPct: number;
  highValueThreshold: number;
  isAgentEnabled: boolean;
} | null = null;

export interface GuardrailCheckResult {
  allowed: boolean;
  reason?: string;
  requiresManualConfirm?: boolean;
}

export const agentGuardrailService = {
  isPaused(): boolean {
    return isAgentPausedRuntime;
  },

  async setPaused(paused: boolean, updatedBy: string = 'admin'): Promise<void> {
    isAgentPausedRuntime = paused;
    if (!cachedConfig) {
      cachedConfig = {
        maxSpendPerRequest: env.AGENT_MAX_SPEND_PER_REQUEST,
        maxSpendPerDay: env.AGENT_MAX_SPEND_PER_DAY,
        minBalanceFloor: env.AGENT_MIN_BALANCE_FLOOR,
        priceDeltaAlertPct: env.AGENT_PRICE_DELTA_ALERT_PCT,
        highValueThreshold: env.AGENT_HIGH_VALUE_THRESHOLD,
        isAgentEnabled: !paused,
      };
    } else {
      cachedConfig.isAgentEnabled = !paused;
    }
    logger.info({ isPaused: paused, updatedBy }, 'Agent runtime status changed');

    try {
      await prisma.agentOperationalConfig.upsert({
        where: { id: 'default' },
        create: {
          id: 'default',
          maxSpendPerRequest: env.AGENT_MAX_SPEND_PER_REQUEST,
          maxSpendPerDay: env.AGENT_MAX_SPEND_PER_DAY,
          minBalanceFloor: env.AGENT_MIN_BALANCE_FLOOR,
          priceDeltaAlertPct: env.AGENT_PRICE_DELTA_ALERT_PCT,
          highValueThreshold: env.AGENT_HIGH_VALUE_THRESHOLD,
          isAgentEnabled: !paused,
          updatedBy,
          approvedAt: new Date(),
        },
        update: {
          isAgentEnabled: !paused,
          updatedBy,
          approvedAt: new Date(),
        },
      });
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to persist agent status to AgentOperationalConfig in DB');
    }
  },

  isEnabled(): boolean {
    return env.AGENT_ENABLED && !isAgentPausedRuntime;
  },

  async getOperationalConfig() {
    try {
      const dbConfig = await prisma.agentOperationalConfig.findUnique({
        where: { id: 'default' },
      });
      if (dbConfig) {
        cachedConfig = {
          maxSpendPerRequest: dbConfig.maxSpendPerRequest,
          maxSpendPerDay: dbConfig.maxSpendPerDay,
          minBalanceFloor: dbConfig.minBalanceFloor,
          priceDeltaAlertPct: dbConfig.priceDeltaAlertPct,
          highValueThreshold: dbConfig.highValueThreshold,
          isAgentEnabled: dbConfig.isAgentEnabled,
        };
        isAgentPausedRuntime = !dbConfig.isAgentEnabled;
        return dbConfig;
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to read AgentOperationalConfig from DB, falling back to env');
    }

    return {
      id: 'default',
      maxSpendPerRequest: env.AGENT_MAX_SPEND_PER_REQUEST,
      maxSpendPerDay: env.AGENT_MAX_SPEND_PER_DAY,
      minBalanceFloor: env.AGENT_MIN_BALANCE_FLOOR,
      priceDeltaAlertPct: env.AGENT_PRICE_DELTA_ALERT_PCT,
      highValueThreshold: env.AGENT_HIGH_VALUE_THRESHOLD,
      isAgentEnabled: env.AGENT_ENABLED && !isAgentPausedRuntime,
      updatedBy: 'env-default',
      approvedAt: null,
      updatedAt: new Date(),
    };
  },

  getSettings() {
    const dynamic = cachedConfig || {
      maxSpendPerRequest: env.AGENT_MAX_SPEND_PER_REQUEST,
      maxSpendPerDay: env.AGENT_MAX_SPEND_PER_DAY,
      minBalanceFloor: env.AGENT_MIN_BALANCE_FLOOR,
      priceDeltaAlertPct: env.AGENT_PRICE_DELTA_ALERT_PCT,
      highValueThreshold: env.AGENT_HIGH_VALUE_THRESHOLD,
      isAgentEnabled: !isAgentPausedRuntime,
    };

    return {
      enabled: env.AGENT_ENABLED && dynamic.isAgentEnabled,
      paused: isAgentPausedRuntime || !dynamic.isAgentEnabled,
      // Layer 1 Hard Caps: Dynamic config cannot exceed hard ceiling in env
      maxSpendPerRequest: Math.min(dynamic.maxSpendPerRequest, env.AGENT_MAX_SPEND_PER_REQUEST),
      maxSpendPerDay: Math.min(dynamic.maxSpendPerDay, env.AGENT_MAX_SPEND_PER_DAY),
      minBalanceFloor: Math.max(dynamic.minBalanceFloor, env.AGENT_MIN_BALANCE_FLOOR),
      priceDeltaAlertPct: dynamic.priceDeltaAlertPct,
      allowedSuppliers: env.AGENT_ALLOWED_SUPPLIER_CODES.split(',').map((s) => s.trim().toUpperCase()),
      highValueThreshold: dynamic.highValueThreshold,
    };
  },

  async evaluateGuardrail(params: {
    quotedPrice: number;
    supplierCode: string;
  }): Promise<GuardrailCheckResult> {
    const { quotedPrice, supplierCode } = params;

    // Refresh dynamic operational config from DB if possible
    await this.getOperationalConfig();

    const settings = this.getSettings();

    // 1. Master Kill Switch / Agent Enabled
    if (!env.AGENT_ENABLED) {
      return { allowed: false, reason: 'Autonomous purchasing agent is disabled globally in configuration.' };
    }
    if (settings.paused) {
      return { allowed: false, reason: 'Autonomous purchasing agent is paused via admin emergency kill switch.' };
    }

    // 2. Supplier Allowlist
    const normalizedSupplier = supplierCode.toUpperCase();
    if (!settings.allowedSuppliers.includes(normalizedSupplier)) {
      return {
        allowed: false,
        reason: `Supplier ${normalizedSupplier} is not in AGENT_ALLOWED_SUPPLIER_CODES allowlist (${settings.allowedSuppliers.join(', ')}).`,
      };
    }

    // 3. Per-Request Spend Cap
    if (quotedPrice > settings.maxSpendPerRequest) {
      return {
        allowed: false,
        reason: `Quoted price (${quotedPrice}) exceeds AGENT_MAX_SPEND_PER_REQUEST ceiling (${settings.maxSpendPerRequest}).`,
      };
    }

    // 4. Daily Aggregate Spend Cap
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todaySpendAgg = await prisma.transaction.aggregate({
      where: {
        createdAt: { gte: todayStart },
        status: { in: ['COMPLETED', 'SUPPLIER_OK', 'VENDING_RETRY'] },
      },
      _sum: { totalPrice: true },
    });

    const currentDailySpend = todaySpendAgg._sum.totalPrice || 0;
    if (currentDailySpend + quotedPrice > settings.maxSpendPerDay) {
      return {
        allowed: false,
        reason: `Daily aggregate spend limit reached. Current: ${currentDailySpend}, Order: ${quotedPrice}, Cap: ${settings.maxSpendPerDay}.`,
      };
    }

    // 5. High-Value Threshold Check (Forces manual confirmation if exceeded)
    const requiresManualConfirm = quotedPrice >= settings.highValueThreshold;

    return {
      allowed: true,
      requiresManualConfirm,
    };
  },
};
