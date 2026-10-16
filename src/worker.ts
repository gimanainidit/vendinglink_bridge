import { supplierOrderWorker } from './queues/workers/supplierOrder.worker';
import { vendingDeliveryWorker } from './queues/workers/vendingDelivery.worker';
import { reconcileWorker } from './queues/workers/reconcile.worker';
import { productSearchWorker } from './queues/workers/productSearch.worker';
import { redisConnection } from './queues/connection';
import { runSweeper } from './queues/sweeper';
import { runBalanceMonitor } from './services/balanceMonitorService';
import { logger } from './lib/logger';
import { prisma } from './db';

const startWorker = async () => {
  logger.info('Starting BullMQ Workers...');

  // Start sweeper immediately, and then every 10 minutes
  await runSweeper();
  const sweeperInterval = setInterval(runSweeper, 10 * 60 * 1000);

  // Start balance monitor check immediately, and then every 30 minutes (BR-P2a-7)
  await runBalanceMonitor();
  const balanceInterval = setInterval(runBalanceMonitor, 30 * 60 * 1000);

  const shutdown = async () => {
    logger.info('Shutting down workers...');
    clearInterval(sweeperInterval);
    clearInterval(balanceInterval);
    
    await supplierOrderWorker.close();
    await vendingDeliveryWorker.close();
    await reconcileWorker.close();
    await productSearchWorker.close();
    
    redisConnection.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

startWorker().catch((err) => {
  logger.error({ err }, 'Worker startup failed');
  process.exit(1);
});
