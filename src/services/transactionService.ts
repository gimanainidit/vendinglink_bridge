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

export const appendLog = async (
  transactionId: string,
  direction: LogDirection,
  payload: any,
  httpStatus?: number,
  durationMs?: number
) => {
  let redactedPayload = payload;
  
  // Basic payload redaction before storing stringified JSON
  if (payload && typeof payload === 'object') {
    const p = { ...payload };
    if (p.headers) {
      if (p.headers['authorization']) p.headers['authorization'] = '[REDACTED]';
      if (p.headers['x-api-key']) p.headers['x-api-key'] = '[REDACTED]';
    }
    if (p.data) {
      if (p.data.delivered_key) p.data.delivered_key = '[REDACTED]';
      if (p.data.delivered_keys) p.data.delivered_keys = '[REDACTED]';
    }
    redactedPayload = p;
  }

  return prisma.transactionLog.create({
    data: {
      transactionId,
      direction,
      httpStatus,
      durationMs,
      payload: JSON.stringify(redactedPayload),
    },
  });
};
