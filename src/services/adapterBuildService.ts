import { prisma } from '../db';
import { env } from '../config/env';
import { decryptCredentials } from '../lib/crypto';
import { credentialSanitizer } from './credentialSanitizer';
import { logger } from '../lib/logger';

async function sendTelegramAlert(message: string): Promise<void> {
  if (!env.ADMIN_TELEGRAM_ID) return;
  try {
    const { bot } = await import('../telegram/bot.js');
    const adminIds = env.ADMIN_TELEGRAM_ID.split(',').map((id) => id.trim());
    for (const adminId of adminIds) {
      await bot.telegram.sendMessage(adminId, message, { parse_mode: 'HTML' }).catch((e: any) => {
        logger.error({ err: e.message, adminId }, 'Failed to send Telegram build notification');
      });
    }
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to load bot for telegram alert');
  }
}

export class AdapterBuildService {
  /**
   * Enqueues an adapter build job for Hermes Agent runner if feature flag is active.
   */
  async createBuildJob(supplierCode: string): Promise<{ queued: boolean; job?: any; reason?: string }> {
    const code = supplierCode.toUpperCase();

    if (!env.AGENT_ADAPTER_BUILD_ENABLED) {
      logger.info({ code }, 'Agent adapter build skipped: AGENT_ADAPTER_BUILD_ENABLED is false');
      return { queued: false, reason: 'AGENT_ADAPTER_BUILD_ENABLED is disabled in configuration' };
    }

    const supplier = await prisma.supplier.findUnique({
      where: { code },
    });

    if (!supplier) {
      return { queued: false, reason: `Supplier ${code} not found in database` };
    }

    // Check for existing pending or processing job
    const existingJob = await prisma.adapterBuildJob.findFirst({
      where: {
        supplierCode: code,
        status: { in: ['QUEUED', 'PROCESSING'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingJob) {
      logger.info({ code, jobId: existingJob.id }, 'Existing adapter build job already in progress');
      return { queued: true, job: existingJob, reason: 'Build job already queued or in progress' };
    }

    // Decrypt credentials and run sanitizer layer
    let rawCredentials = {};
    try {
      rawCredentials = decryptCredentials(supplier.credentialsEnc);
    } catch (err: any) {
      logger.warn({ code, err: err.message }, 'Failed to decrypt credentials for build job, continuing with empty creds');
    }

    const sanitizedSpec = credentialSanitizer.buildSanitizedSpec({
      code: supplier.code,
      displayName: supplier.displayName,
      baseUrl: supplier.baseUrl,
      authType: supplier.authType,
      descriptor: supplier.descriptor,
      credentials: rawCredentials,
    });

    const job = await prisma.adapterBuildJob.create({
      data: {
        supplierCode: code,
        status: 'QUEUED',
        sanitizedSpec: JSON.stringify(sanitizedSpec),
      },
    });

    logger.info({ code, jobId: job.id }, 'Adapter build job enqueued for Hermes Agent runner');

    // Send Telegram alert to admin
    const msg =
      `🤖 <b>[Hermes Agentic Adapter Builder]</b>\n` +
      `Supplier: <b>${supplier.displayName}</b> (<code>${code}</code>)\n` +
      `Job ID: <code>${job.id}</code>\n` +
      `Status: <b>QUEUED</b>\n\n` +
      `Hermes Agent Runner di VPS akan men-generate adapter TypeScript + Vitest test di sandbox dan membuka <b>GitHub Draft PR</b>.`;
    await sendTelegramAlert(msg);

    return { queued: true, job };
  }

  /**
   * Retrieves pending queued jobs for Hermes runner to consume.
   */
  async getPendingJobs() {
    return prisma.adapterBuildJob.findMany({
      where: { status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Updates job status (called by Hermes Runner).
   */
  async updateJobStatus(
    jobId: string,
    params: {
      status: 'PROCESSING' | 'PR_CREATED' | 'FAILED';
      prUrl?: string;
      branchName?: string;
      error?: string;
    }
  ) {
    const job = await prisma.adapterBuildJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw new Error(`AdapterBuildJob ${jobId} not found`);
    }

    const updated = await prisma.adapterBuildJob.update({
      where: { id: jobId },
      data: {
        status: params.status,
        prUrl: params.prUrl ?? job.prUrl,
        branchName: params.branchName ?? job.branchName,
        error: params.error ?? null,
      },
    });

    logger.info({ jobId, status: params.status, prUrl: params.prUrl }, 'Adapter build job updated by Hermes');

    // Notify Telegram Admin when PR is created or if build failed
    if (params.status === 'PR_CREATED') {
      const msg =
        `🎉 <b>[Hermes Adapter Built: Draft PR Ready]</b>\n` +
        `Supplier: <b>${job.supplierCode}</b>\n` +
        `Branch: <code>${params.branchName || 'feat/adapter-' + job.supplierCode.toLowerCase()}</code>\n` +
        `Draft PR: <a href="${params.prUrl}">${params.prUrl}</a>\n\n` +
        `✅ <i>Vitest sandbox mock tests passed!</i>\n` +
        `<i>Review & merge Draft PR di GitHub, lalu jalankan CI/CD deploy untuk mengaktifkan supplier ini.</i>`;
      await sendTelegramAlert(msg);
    } else if (params.status === 'FAILED') {
      const msg =
        `❌ <b>[Hermes Adapter Build Failed]</b>\n` +
        `Supplier: <b>${job.supplierCode}</b>\n` +
        `Error: <code>${params.error || 'Unknown failure in sandbox'}</code>\n\n` +
        `<i>Periksa log sandbox di VPS Hermes runner.</i>`;
      await sendTelegramAlert(msg);
    }

    return updated;
  }
}

export const adapterBuildService = new AdapterBuildService();
