import { supplierFactory } from '../suppliers/SupplierFactory';
import { createTransaction, updateTransactionStatus } from './transactionService';
import { encryptKeys } from '../lib/crypto';
import { logger } from '../lib/logger';
import { env } from '../config/env';

// This function will be called by the Telegram callback directly (to enqueue) 
// or by the Queue worker to execute.

export const createPendingTransaction = async (
  supplierCode: string,
  productId: string,
  qty: number,
  emails: string[] | undefined,
  chatId: string
) => {
  const adapter = supplierFactory.getAdapter(supplierCode);
  const product = await adapter.getProduct(productId);

  if (!product) throw new Error('Product not found');

  const transactionId = `BRG-${new Date().toISOString().replace(/\D/g, '').slice(0, 8)}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
  
  // Format VL ID
  const vlProductId = `${adapter.code}-${productId}`;

  const tx = await createTransaction({
    transactionId,
    supplierCode: adapter.code,
    supplierProductId: productId,
    vlProductId,
    productName: product.name,
    qty,
    emails: emails ? emails.join(',') : undefined,
    telegramChatId: chatId,
  });

  return tx;
};

export const executePurchase = async (transactionId: string) => {
  // In Phase 3, this is called by the BullMQ worker
  // For Phase 2, we will call this directly in confirmBuy to test

  // 1. Fetch TX
  // Normally we would use Prisma here, but since this is just logic outline:
  // let's assume we pass the transaction object or fetch it
  logger.info(`Executing purchase for TX: ${transactionId}`);
  
  // Actual implementation will live in Phase 3 workers
};
