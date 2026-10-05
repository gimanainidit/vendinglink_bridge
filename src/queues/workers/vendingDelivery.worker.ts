import { Worker } from 'bullmq';
import { redisConnection } from '../connection';
import { prisma } from '../../db';
import { deliverToVendingLink, VendingLinkDeliveryError } from '../../vendinglink/vendingLinkClient';
import { decryptKeys } from '../../lib/crypto';
import { updateTransactionStatus } from '../../services/transactionService';
import { bot } from '../../telegram/bot';
import { logger } from '../../lib/logger';

export const vendingDeliveryWorker = new Worker(
  'vending-delivery',
  async (job) => {
    const { txId } = job.data;

    const tx = await prisma.transaction.findUnique({ where: { id: txId } });
    if (!tx) return;
    
    // Only process if it's SUPPLIER_OK or VENDING_RETRY
    if (tx.status !== 'SUPPLIER_OK' && tx.status !== 'VENDING_RETRY') {
      return;
    }

    if (!tx.deliveredKeysEnc) {
      throw new Error(`TX ${tx.transactionId} missing encrypted keys`);
    }

    const items = decryptKeys(tx.deliveredKeysEnc);

    try {
      await deliverToVendingLink(
        tx.transactionId,
        tx.supplierCode,
        tx.supplierProductId,
        tx.vlProductId,
        tx.qty,
        items
      );

      // Success
      await updateTransactionStatus(tx.id, tx.status, 'COMPLETED', {
        deliveryAttempts: tx.deliveryAttempts + 1,
        lastError: null,
      });

      let summary = `✅ Transaction complete. VendingLink stock updated.\n`;
      summary += `TX: ${tx.transactionId}\n`;
      summary += `Product: ${tx.productName || tx.vlProductId} (x${tx.qty})\n`;
      if (tx.deliveryAttempts > 0) {
        summary += `(Resolved after ${tx.deliveryAttempts + 1} attempts)`;
      }

      await bot.telegram.sendMessage(tx.telegramChatId, summary);

    } catch (err: any) {
      const attempts = tx.deliveryAttempts + 1;
      
      // We manually manage attempts in DB in addition to BullMQ's attempt counter
      await prisma.transaction.update({
        where: { id: tx.id },
        data: { deliveryAttempts: attempts, lastError: err.message },
      });

      if (err instanceof VendingLinkDeliveryError && !err.isRetryable) {
        // Non-retryable error (e.g. 400 Bad Request)
        await updateTransactionStatus(tx.id, tx.status, 'NEEDS_REVIEW');
        await bot.telegram.sendMessage(tx.telegramChatId, `🚨 Non-retryable VendingLink Error on TX ${tx.transactionId}:\n${err.message}\nNeeds manual review.`);
        // Stop BullMQ from retrying by NOT throwing
        return;
      }

      // If it's the first retry, notify user
      if (tx.status === 'SUPPLIER_OK') {
        await updateTransactionStatus(tx.id, 'SUPPLIER_OK', 'VENDING_RETRY');
        await bot.telegram.sendMessage(tx.telegramChatId, `⚠️ VendingLink unreachable, entered retry mode (TX: ${tx.transactionId}).`);
      }

      // Check max attempts (let's say we rely on BullMQ's max attempts, but if it exhausts, we handle in 'failed' event)
      // Throw to let BullMQ handle the backoff retry
      throw err;
    }
  },
  { connection: redisConnection }
);

vendingDeliveryWorker.on('failed', async (job, err) => {
  // If job exceeded max attempts
  if (job && job.attemptsMade === job.opts.attempts) {
    const { txId } = job.data;
    const tx = await prisma.transaction.findUnique({ where: { id: txId } });
    if (tx && tx.status === 'VENDING_RETRY') {
      await updateTransactionStatus(tx.id, 'VENDING_RETRY', 'NEEDS_REVIEW');
      await bot.telegram.sendMessage(
        tx.telegramChatId, 
        `🚨 Max delivery attempts reached for TX ${tx.transactionId}. Marked as NEEDS_REVIEW.\nError: ${err.message}\nUse /retry <TX_ID> to try again later.`
      );
    }
  }
});

vendingDeliveryWorker.on('error', (err) => {
  logger.error(err);
});
