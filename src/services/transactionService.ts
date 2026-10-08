import { prisma } from '../db';
import { TransactionStatus, LogDirection } from '@prisma/client';
import { logger } from '../lib/logger';

export const createTransaction = async (data: {
  transactionId: string;
  supplierCode: string;
  supplierProductId: string;
  vlProductId: string;
  productName?: string;
  qty: number;
  emails?: string;
  telegramChatId: string;
}) => {
  return prisma.transaction.create({
    data: {
      ...data,
      status: 'PENDING',
    },
  });
};

export const updateTransactionStatus = async (
  id: string,
  fromStatus: TransactionStatus,
  toStatus: TransactionStatus,
  data?: any
) => {
  // We use updateMany as an optimistic lock to ensure we only transition from the expected state
  const result = await prisma.transaction.updateMany({
    where: {
      id,
      status: fromStatus,
    },
    data: {
      status: toStatus,
      ...data,
      updatedAt: new Date(),
    },
  });

  if (result.count === 0) {
    throw new Error(`Failed to transition transaction ${id} from ${fromStatus} to ${toStatus}`);
  }

  return prisma.transaction.findUnique({ where: { id } });
};

const deepRedact = (obj: any): any => {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => deepRedact(item));
  }

  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (
      key === 'delivered_key' ||
      key === 'delivered_keys' ||
      key === 'items' ||
      lowerKey === 'authorization' ||
      lowerKey === 'x-api-key'
    ) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = deepRedact(value);
    }
  }
  return result;
};

import fs from 'fs';

export const appendLog = async (
  transactionId: string,
  direction: LogDirection,
  payload: any,
  httpStatus?: number,
  durationMs?: number
) => {
  if (direction === 'SUPPLIER_RES') {
    try {
      fs.writeFileSync(`/app/audit_logs/${transactionId}_SUPPLIER_RES.json`, JSON.stringify(payload, null, 2));
    } catch (e) {
      logger.error(`Failed to write audit log to /app/audit_logs for ${transactionId}`, e);
    }
  }

  const redactedPayload = deepRedact(payload);

  // Note: the `transactionId` passed here is the semantic BRG-... ID.
  // The Prisma relation expects the internal CUID (`id`).
  const tx = await prisma.transaction.findUnique({
    where: { transactionId }
  });

  if (!tx) {
    logger.warn(`Could not find transaction ${transactionId} to append log`);
    return;
  }

  return prisma.transactionLog.create({
    data: {
      transactionId: tx.id,
      direction,
      httpStatus,
      durationMs,
      payload: JSON.stringify(redactedPayload),
    },
  });
};
