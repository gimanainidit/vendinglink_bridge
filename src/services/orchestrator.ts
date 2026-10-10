import { supplierFactory } from '../suppliers/SupplierFactory';
import { createTransaction, updateTransactionStatus } from './transactionService';
import { encryptKeys } from '../lib/crypto';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { prisma } from '../db';

/**
 * Resolve the VendingLink product ID from the local ProductMapping table.
 * Returns null when no mapping exists — callers should log a warning and
 * fall back to '[UNMAPPED]' rather than silently proceeding.
 */
export async function resolveVlProductId(
  supplierCode: string,
  supplierProductId: string
): Promise<string | null> {
  const mapping = await prisma.productMapping.findUnique({
    where: {
      supplierCode_supplierProductId: { supplierCode, supplierProductId },
    },
  });

  if (!mapping) {
    logger.warn(
      { supplierCode, supplierProductId },
      'No ProductMapping found — vlProductId unresolved. Use /map to register this product.'
    );
    return null;
  }

  return mapping.vlProductId;
}

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
  
  // Resolve vlProductId from ProductMapping. Falls back to '[UNMAPPED]' so the
  // transaction is still recorded — admin can fix the mapping later with /map.
  const vlProductId = (await resolveVlProductId(adapter.code, productId)) ?? '[UNMAPPED]';

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
