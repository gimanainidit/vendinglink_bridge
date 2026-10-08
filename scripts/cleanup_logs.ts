import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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

async function cleanupLogs() {
  console.log('Fetching all TransactionLogs...');
  const logs = await prisma.transactionLog.findMany();
  console.log(`Found ${logs.length} logs to inspect.`);

  let updatedCount = 0;

  for (const log of logs) {
    try {
      const payloadObj = JSON.parse(log.payload);
      const redactedPayload = deepRedact(payloadObj);
      
      const newPayloadStr = JSON.stringify(redactedPayload);
      
      if (newPayloadStr !== log.payload) {
        await prisma.transactionLog.update({
          where: { id: log.id },
          data: { payload: newPayloadStr }
        });
        updatedCount++;
      }
    } catch (err) {
      // Abaikan jika bukan JSON
    }
  }

  console.log(`✅ Cleanup complete! Redacted keys from ${updatedCount} logs.`);
}

cleanupLogs()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
