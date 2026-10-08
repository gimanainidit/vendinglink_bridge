import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

async function exportLogs() {
  console.log('Fetching all TransactionLogs...');
  const logs = await prisma.transactionLog.findMany({
    include: {
      transaction: {
        select: {
          transactionId: true,
          supplierCode: true,
          vlProductId: true
        }
      }
    },
    orderBy: {
      createdAt: 'asc'
    }
  });

  console.log(`Found ${logs.length} logs. Processing...`);

  const formattedLogs = logs.map(log => {
    let parsedPayload;
    try {
      parsedPayload = JSON.parse(log.payload);
    } catch (e) {
      parsedPayload = log.payload; // fallback if not JSON
    }

    return {
      id: log.id,
      bridgeTxId: log.transaction.transactionId,
      direction: log.direction,
      httpStatus: log.httpStatus,
      durationMs: log.durationMs,
      createdAt: log.createdAt,
      payload: parsedPayload
    };
  });

  const outputPath = path.join(process.cwd(), 'backups', 'exported_transaction_logs.json');
  
  // Buat folder backups jika belum ada
  if (!fs.existsSync(path.join(process.cwd(), 'backups'))) {
    fs.mkdirSync(path.join(process.cwd(), 'backups'));
  }

  fs.writeFileSync(outputPath, JSON.stringify(formattedLogs, null, 2));
  console.log(`\n✅ Export success! File saved to: ${outputPath}`);
}

exportLogs()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
