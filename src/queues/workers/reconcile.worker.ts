import { Worker } from 'bullmq';
import { redisConnection } from '../connection';
import { prisma } from '../../db';
import { supplierFactory } from '../../suppliers/SupplierFactory';
import { encryptKeys } from '../../lib/crypto';
import { vendingDeliveryQueue } from '../queues';
import { updateTransactionStatus } from '../../services/transactionService';
import { bot } from '../../telegram/bot';
import { logger } from '../../lib/logger';

export const reconcileWorker = new Worker(
  'supplier-reconcile',
  async (job) => {
    const { txId } = job.data;
    
    const tx = await prisma.transaction.findUnique({ where: { id: txId } });
    if (!tx || tx.status !== 'RECONCILING') return;

    try {
      const adapter = supplierFactory.getAdapter(tx.supplierCode);
      
      // Look for the order in the supplier's system
      const result = await adapter.findRecentOrder({
        productId: tx.supplierProductId,
        qty: tx.qty,
        since: tx.createdAt, // This might need a buffer like createdAt - 1 min
      });

      if (result && result.deliveredKeys && result.deliveredKeys.length > 0) {
        // We found it! The purchase succeeded but we timed out receiving it.
        const encryptedKeys = encryptKeys(result.deliveredKeys);

        await updateTransactionStatus(tx.id, 'RECONCILING', 'SUPPLIER_OK', {
          supplierOrderId: result.orderId,
          deliveredKeysEnc: encryptedKeys,
          lastError: null,
        });

        await bot.telegram.sendMessage(
          tx.telegramChatId, 
          `✅ Reconciliation successful for TX ${tx.transactionId}. Keys found. Enqueueing to VendingLink...`
        );

        await vendingDeliveryQueue.add(
          'deliver', 
          { txId: tx.id }, 
          { jobId: tx.transactionId }
        );
        return;
      }

      // If not found, throw error to trigger BullMQ backoff retry
      throw new Error('Order not found on supplier end yet.');
    } catch (err: any) {
      throw err; // Trigger retry
    }
  },
  { connection: redisConnection }
);

reconcileWorker.on('failed', async (job, err) => {
  if (job && job.attemptsMade === job.opts.attempts) {
    const { txId } = job.data;
    const tx = await prisma.transaction.findUnique({ where: { id: txId } });
    if (tx && tx.status === 'RECONCILING') {
      await updateTransactionStatus(tx.id, 'RECONCILING', 'NEEDS_REVIEW');
      await bot.telegram.sendMessage(
        tx.telegramChatId, 
        `🚨 Reconciliation exhausted for TX ${tx.transactionId}. Could not find the order on supplier side. Marked as NEEDS_REVIEW.`
      );
    }
  }
});

reconcileWorker.on('error', (err) => {
  logger.error(err);
});
