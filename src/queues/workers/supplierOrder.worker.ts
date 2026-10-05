import { Worker } from 'bullmq';
import { redisConnection } from '../connection';
import { prisma } from '../../db';
import { supplierFactory } from '../../suppliers/SupplierFactory';
import { encryptKeys } from '../../lib/crypto';
import { vendingDeliveryQueue, supplierReconcileQueue } from '../queues';
import { 
  SupplierRejectedError, 
  SupplierFailedRefundedError, 
  SupplierUnknownOutcomeError 
} from '../../suppliers/ISupplierAdapter';
import { updateTransactionStatus } from '../../services/transactionService';
import { bot } from '../../telegram/bot';
import { logger } from '../../lib/logger';

export const supplierOrderWorker = new Worker(
  'supplier-order',
  async (job) => {
    const { txId } = job.data; // This is the DB record ID

    const tx = await prisma.transaction.findUnique({ where: { id: txId } });
    if (!tx || tx.status !== 'PENDING') return;

    try {
      const adapter = supplierFactory.getAdapter(tx.supplierCode);
      const emails = tx.emails ? tx.emails.split(',') : undefined;

      // Purchase
      const result = await adapter.purchaseProduct({
        productId: tx.supplierProductId,
        qty: tx.qty,
        emails,
        transactionId: tx.transactionId,
      });

      // Encrypt keys
      const encryptedKeys = encryptKeys(result.deliveredKeys);

      // Update DB to SUPPLIER_OK
      await updateTransactionStatus(tx.id, 'PENDING', 'SUPPLIER_OK', {
        supplierOrderId: result.orderId,
        deliveredKeysEnc: encryptedKeys,
        balanceBefore: result.balance.before,
        balanceAfter: result.balance.after,
      });

      // Notify User
      let msg = `✅ Supplier responded. Balance deducted.\n`;
      if (result.balance.after !== undefined) {
        msg += `Remaining balance: Rp${result.balance.after.toLocaleString('id-ID')}\n`;
      }
      msg += `Continuing to VendingLink...`;
      await bot.telegram.sendMessage(tx.telegramChatId, msg);

      // Enqueue to VendingLink delivery
      await vendingDeliveryQueue.add(
        'deliver', 
        { txId: tx.id }, 
        { jobId: tx.transactionId } // Ensure idempotency in queue
      );

    } catch (err: any) {
      if (err instanceof SupplierRejectedError) {
        await updateTransactionStatus(tx.id, 'PENDING', 'FAILED', { lastError: err.message });
        await bot.telegram.sendMessage(tx.telegramChatId, `❌ Purchase Rejected:\n${err.message}`);
      } else if (err instanceof SupplierFailedRefundedError) {
        await updateTransactionStatus(tx.id, 'PENDING', 'FAILED', { lastError: err.message });
        await bot.telegram.sendMessage(tx.telegramChatId, `⚠️ Supplier Failed (Refunded):\n${err.message}`);
      } else if (err instanceof SupplierUnknownOutcomeError) {
        await updateTransactionStatus(tx.id, 'PENDING', 'RECONCILING', { lastError: err.message });
        await bot.telegram.sendMessage(tx.telegramChatId, `🚨 Network Timeout / Unknown Status for TX ${tx.transactionId}.\nMoving to reconcile queue...`);
        
        // Enqueue to reconcile queue
        await supplierReconcileQueue.add(
          'reconcile',
          { txId: tx.id },
          { jobId: tx.transactionId } // Ensure idempotency
        );
      } else {
        // Unexpected error (e.g. bug in our code). Still mark as needs review to be safe.
        logger.error({ err }, 'Unexpected error in supplierOrderWorker');
        await updateTransactionStatus(tx.id, 'PENDING', 'NEEDS_REVIEW', { lastError: err.message });
        await bot.telegram.sendMessage(tx.telegramChatId, `🚨 Critical Internal Error on TX ${tx.transactionId}:\n${err.message}`);
      }
    }
  },
  { 
    connection: redisConnection,
    concurrency: 1, // Only process one order at a time to prevent race conditions safely
  }
);

supplierOrderWorker.on('error', (err) => {
  logger.error(err);
});
