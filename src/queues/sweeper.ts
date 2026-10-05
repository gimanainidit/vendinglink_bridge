import { prisma } from '../db';
import { supplierOrderQueue, vendingDeliveryQueue, supplierReconcileQueue } from './queues';
import { logger } from '../lib/logger';

export const runSweeper = async () => {
  logger.info('Running DB Sweeper to find orphaned transactions...');

  try {
    // 1. PENDING -> Supplier Order Queue
    const pending = await prisma.transaction.findMany({ where: { status: 'PENDING' } });
    for (const tx of pending) {
      await supplierOrderQueue.add('order', { txId: tx.id }, { jobId: tx.transactionId });
    }
    if (pending.length > 0) logger.info(`Re-enqueued ${pending.length} PENDING transactions.`);

    // 2. SUPPLIER_OK or VENDING_RETRY -> Vending Delivery Queue
    const delivery = await prisma.transaction.findMany({
      where: {
        status: { in: ['SUPPLIER_OK', 'VENDING_RETRY'] },
      },
    });
    for (const tx of delivery) {
      await vendingDeliveryQueue.add('deliver', { txId: tx.id }, { jobId: tx.transactionId });
    }
    if (delivery.length > 0) logger.info(`Re-enqueued ${delivery.length} transactions for delivery.`);

    // 3. RECONCILING -> Supplier Reconcile Queue
    const reconciling = await prisma.transaction.findMany({ where: { status: 'RECONCILING' } });
    for (const tx of reconciling) {
      await supplierReconcileQueue.add('reconcile', { txId: tx.id }, { jobId: tx.transactionId });
    }
    if (reconciling.length > 0) logger.info(`Re-enqueued ${reconciling.length} RECONCILING transactions.`);

  } catch (err) {
    logger.error({ err }, 'Sweeper failed');
  }
};
