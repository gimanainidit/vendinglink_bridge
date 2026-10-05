import { supplierOrderWorker } from './queues/workers/supplierOrder.worker';
import { vendingDeliveryWorker } from './queues/workers/vendingDelivery.worker';
import { reconcileWorker } from './queues/workers/reconcile.worker';
import { redisConnection } from './queues/connection';
import { runSweeper } from './queues/sweeper';
import { logger } from './lib/logger';
import { prisma } from './db';

const startWorker = async () => {
  logger.info('Starting BullMQ Workers...');

  // Start sweeper immediately, and then every 10 minutes
  await runSweeper();
  const sweeperInterval = setInterval(runSweeper, 10 * 60 * 1000);

  const shutdown = async () => {
    logger.info('Shutting down workers...');
    clearInterval(sweeperInterval);
    
    await supplierOrderWorker.close();
    await vendingDeliveryWorker.close();
    await reconcileWorker.close();
    
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
