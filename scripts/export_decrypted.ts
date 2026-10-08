import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { decryptKeys } from '../src/lib/crypto';

const prisma = new PrismaClient();

async function exportDecryptedData() {
  console.log('Fetching transactions...');
  const transactions = await prisma.transaction.findMany();

  console.log(`Found ${transactions.length} transactions. Decrypting keys...`);

  const decryptedTransactions = transactions.map((tx) => {
    let decryptedKeys = null;
    if (tx.deliveredKeysEnc) {
      try {
        decryptedKeys = decryptKeys(tx.deliveredKeysEnc);
      } catch (err) {
        console.error(`Failed to decrypt keys for transaction ${tx.id}:`, err);
        decryptedKeys = ['[DECRYPTION_FAILED]'];
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { deliveredKeysEnc, ...rest } = tx;
    return {
      ...rest,
      deliveredKeys: decryptedKeys,
    };
  });

  const outputPath = path.join(process.cwd(), 'backups', 'decrypted_transactions.json');
  
  if (!fs.existsSync(path.join(process.cwd(), 'backups'))) {
    fs.mkdirSync(path.join(process.cwd(), 'backups'));
  }

  fs.writeFileSync(outputPath, JSON.stringify(decryptedTransactions, null, 2));
  console.log(`\n✅ Export success! File saved to: ${outputPath}`);
}

exportDecryptedData()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
