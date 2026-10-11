import { env } from '../config/env';
import { prisma } from '../db';
import { logger } from '../lib/logger';

// Runtime pause flag controllable via Telegram bot (/agent pause | /agent resume)
let isAgentPausedRuntime = false;

export interface GuardrailCheckResult {
  allowed: boolean;
  reason?: string;
  requiresManualConfirm?: boolean;
}

export const agentGuardrailService = {
  isPaused(): boolean {
    return isAgentPausedRuntime;
  },

  setPaused(paused: boolean): void {
    isAgentPausedRuntime = paused;
    logger.info({ isPaused: paused }, 'Agent runtime status changed');
  },

  isEnabled(): boolean {
    return env.AGENT_ENABLED && !isAgentPausedRuntime;
  },

  getSettings() {
    return {
      enabled: env.AGENT_ENABLED,
      paused: isAgentPausedRuntime,
      maxSpendPerRequest: env.AGENT_MAX_SPEND_PER_REQUEST,
      maxSpendPerDay: env.AGENT_MAX_SPEND_PER_DAY,
      minBalanceFloor: env.AGENT_MIN_BALANCE_FLOOR,
      allowedSuppliers: env.AGENT_ALLOWED_SUPPLIER_CODES.split(',').map((s) => s.trim().toUpperCase()),
      highValueThreshold: env.AGENT_HIGH_VALUE_THRESHOLD,
    };
  },

  /**
   * Evaluates autonomous procurement guardrails in priority order:
   * AGENT_ENABLED > allowlist > per-request cap > daily cap > high value threshold
   */
  async evaluateGuardrail(params: {
    quotedPrice: number;
    supplierCode: string;
  }): Promise<GuardrailCheckResult> {
    const { quotedPrice, supplierCode } = params;
    const settings = this.getSettings();

    // 1. Master Kill Switch / Agent Enabled
    if (!settings.enabled) {
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
