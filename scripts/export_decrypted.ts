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

  const isPlaintext = process.argv.includes('--plaintext');
  const backupDir = path.join(process.cwd(), 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  if (isPlaintext) {
    const outputPath = path.join(backupDir, 'decrypted_transactions.json');
    fs.writeFileSync(outputPath, JSON.stringify(decryptedTransactions, null, 2));
    console.warn(`\n⚠️  WARNING: Plaintext export explicitly enabled via --plaintext flag.`);
    console.log(`✅ Export success! File saved to: ${outputPath}`);
  } else {
    const { encryptKeys } = await import('../src/lib/crypto');
    const jsonString = JSON.stringify(decryptedTransactions, null, 2);
    const encryptedData = encryptKeys([jsonString]);
    const outputPath = path.join(backupDir, 'decrypted_transactions.enc.json');
    fs.writeFileSync(outputPath, JSON.stringify({ encryptedData, exportedAt: new Date().toISOString() }, null, 2));
    console.log(`\n🔒 Export success! Output is ENCRYPTED with KEYS_ENCRYPTION_KEY.`);
    console.log(`File saved to: ${outputPath}`);
    console.log(`(To export unencrypted JSON, re-run with explicit --plaintext flag)`);
  }
}

exportDecryptedData()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
