import { Queue } from 'bullmq';
import { redisConnection } from './connection';

// 1. Supplier Order Queue
// This queue places orders with suppliers. Retries are NOT done automatically.
export const supplierOrderQueue = new Queue('supplier-order', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1, // Never automatically retry supplier purchases to avoid double charges
    removeOnComplete: true,
    removeOnFail: false,
  },
});

// 2. VendingLink Delivery Queue
// This queue attempts to deliver the keys to VendingLink.
// We use exponential backoff, up to 12 attempts (~1.5 hours), 
// after which it can be moved to a slow-retry or NEEDS_REVIEW.
export const vendingDeliveryQueue = new Queue('vending-delivery', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 12,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5s, 10s, 20s, 40s...
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

// 3. Supplier Reconcile Queue
// Used to check the status of an order that timed out.
export const supplierReconcileQueue = new Queue('supplier-reconcile', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 6,
    backoff: {
      type: 'fixed',
      delay: 60000, // 1 minute
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});
