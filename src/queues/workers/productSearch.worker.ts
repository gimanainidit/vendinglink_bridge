import { Worker } from 'bullmq';
import { redisConnection } from '../connection';
import { prisma } from '../../db';
import { supplierFactory } from '../../suppliers/SupplierFactory';
import { agentGuardrailService } from '../../services/agentGuardrailService';
import { notifyStorefrontRequestUpdate } from '../../vendinglink/requestNotifier';
import { bot } from '../../telegram/bot';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';

export const productSearchWorker = new Worker(
  'product-search',
  async (job) => {
    const { requestId } = job.data;
    const req = await prisma.productRequest.findUnique({ where: { id: requestId } });
    if (!req) {
      logger.warn({ requestId }, 'ProductRequest not found in worker');
      return;
    }

    if (req.status !== 'SEARCHING') {
      logger.info({ requestId, status: req.status }, 'ProductRequest is not in SEARCHING state, skipping');
      return;
    }

    try {
      // 1. Query registered suppliers in parallel (RZK, PDA, DAI)
      const bestOffer = await supplierFactory.findBestOffer(req.query);

      if (!bestOffer) {
        await prisma.productRequest.update({
          where: { id: req.id },
          data: { status: 'NOT_FOUND', rejectionReason: 'No in-stock offers found across suppliers' },
        });

        await notifyStorefrontRequestUpdate({
          requestId: req.id,
          customerRef: req.customerRef,
          status: 'NOT_FOUND',
          query: req.query,
          categorySlug: req.categorySlug,
          rejectionReason: 'No matching in-stock product found across active suppliers.',
        });
        return;
      }

      const quotedPrice = bestOffer.product.price ?? 0;
      const supplierCode = bestOffer.adapter.code;
      const productId = bestOffer.product.id;

      // 2. Check Customer Max Budget ceiling if specified
      if (req.maxBudget && quotedPrice > req.maxBudget) {
        await prisma.productRequest.update({
          where: { id: req.id },
          data: {
            status: 'NOT_FOUND',
            foundSupplierCode: supplierCode,
            foundProductId: productId,
            quotedPrice,
            rejectionReason: `Best offer price (${quotedPrice}) exceeds customer max budget (${req.maxBudget}).`,
          },
        });

        await notifyStorefrontRequestUpdate({
          requestId: req.id,
          customerRef: req.customerRef,
          status: 'NOT_FOUND',
          query: req.query,
          categorySlug: req.categorySlug,
          quotedPrice,
          rejectionReason: `Lowest offer (${quotedPrice}) exceeds requested budget (${req.maxBudget}).`,
        });
        return;
      }

      // 3. Evaluate Autonomous Procurement Guardrails
      const guardrailResult = await agentGuardrailService.evaluateGuardrail({
        quotedPrice,
        supplierCode,
      });

      if (!guardrailResult.allowed) {
        await prisma.productRequest.update({
          where: { id: req.id },
          data: {
            status: 'REJECTED',
            foundSupplierCode: supplierCode,
            foundProductId: productId,
            quotedPrice,
            rejectionReason: guardrailResult.reason,
          },
        });

        await notifyStorefrontRequestUpdate({
          requestId: req.id,
          customerRef: req.customerRef,
          status: 'REJECTED',
          query: req.query,
          categorySlug: req.categorySlug,
          quotedPrice,
          rejectionReason: guardrailResult.reason,
        });

        // Alert Admin on Telegram
        const adminChatId = env.ADMIN_TELEGRAM_ID.split(',')[0].trim();
        if (adminChatId) {
          await bot.telegram.sendMessage(
            adminChatId,
            `⚠️ *Agent Guardrail Triggered*:\nRequest: \`${req.id}\`\nQuery: ${req.query}\nSupplier: ${supplierCode}\nPrice: ${quotedPrice}\nReason: ${guardrailResult.reason}`,
            { parse_mode: 'Markdown' }
          );
        }
        return;
      }

      // 4. Offer Found and Guardrails Passed
      await prisma.productRequest.update({
        where: { id: req.id },
        data: {
          status: 'FOUND',
          foundSupplierCode: supplierCode,
          foundProductId: productId,
          quotedPrice,
          notifiedAt: new Date(),
        },
      });

      await notifyStorefrontRequestUpdate({
        requestId: req.id,
        customerRef: req.customerRef,
        status: 'FOUND',
        query: req.query,
        categorySlug: req.categorySlug,
        foundSupplierCode: supplierCode,
        foundProductId: productId,
        quotedPrice,
      });

      logger.info(
        { requestId: req.id, supplierCode, productId, quotedPrice },
        'Product search completed successfully'
      );
    } catch (err: any) {
      logger.error({ requestId: req.id, error: err.message }, 'Error during product search worker');
      throw err;
    }
  },
  { connection: redisConnection }
);

productSearchWorker.on('error', (err) => {
  logger.error({ err }, 'Product search worker encountered an error');
});
