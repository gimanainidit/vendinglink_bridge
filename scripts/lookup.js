#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const txId = process.argv[2];
if (!txId) {
  console.log('Usage: node scripts/lookup.js <TRANSACTION_ID>');
  console.log('Example: node scripts/lookup.js BRG-20261012-000001');
  process.exit(1);
}

const auditPath = path.join(process.cwd(), 'audit_logs', `${txId}_SUPPLIER_RES.json`);
console.log('=================================================================');
console.log(`🔍 DETAIL TRANSAKSI: ${txId}`);
console.log('=================================================================');

if (fs.existsSync(auditPath)) {
  console.log(`\n📄 [1] RAW AUDIT LOG DARI SUPPLIER (${auditPath}):`);
  try {
    const rawContent = fs.readFileSync(auditPath, 'utf8');
    console.log(JSON.stringify(JSON.parse(rawContent), null, 2));
  } catch (err) {
    console.log(fs.readFileSync(auditPath, 'utf8'));
  }
} else {
  console.log(`\nℹ️  [1] File audit log '${auditPath}' tidak ditemukan di disk.`);
}

const prisma = new PrismaClient();

async function queryDb() {
  try {
    const tx = await prisma.transaction.findUnique({
      where: { transactionId: txId },
      include: {
        logs: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!tx) {
      console.log(`\n❌ [2] Transaksi '${txId}' tidak ditemukan di Database.`);
      return;
    }

    console.log('\n📊 [2] DATA TRANSAKSI DI DATABASE:');
    console.log(`- Status              : ${tx.status}`);
    console.log(`- Supplier Code       : ${tx.supplierCode}`);
    console.log(`- Supplier Product ID : ${tx.supplierProductId}`);
    console.log(`- Vending Product ID  : ${tx.vlProductId}`);
    console.log(`- Supplier Order ID   : ${tx.supplierOrderId || '-'}`);
    console.log(`- Delivery Attempts   : ${tx.deliveryAttempts}`);
    console.log(`- Last Error          : ${tx.lastError || '-'}`);

    if (tx.deliveredKeysEnc) {
      try {
        let cryptoModule;
        try {
          cryptoModule = require('./dist/lib/crypto');
        } catch {
          cryptoModule = require('../dist/lib/crypto');
        }
        const decrypted = cryptoModule.decryptKeys(tx.deliveredKeysEnc);
        console.log(`- Delivered Keys (Decrypted) :`, decrypted);
      } catch (decErr) {
        console.log(`- Delivered Keys (Encrypted) : ${tx.deliveredKeysEnc}`);
        console.log(`  (Gagal dekripsi: pastikan KEYS_ENCRYPTION_KEY di .env sudah benar)`);
      }
    } else {
      console.log(`- Delivered Keys      : (kosong / belum ada)`);
    }

    if (tx.logs && tx.logs.length > 0) {
      console.log('\n📝 [3] RIWAYAT TRANSACTION LOGS:');
      for (const l of tx.logs) {
        let parsed = l.payload;
        try {
          parsed = JSON.parse(l.payload);
        } catch {}
        console.log(`\n[${l.direction}] HTTP ${l.httpStatus || '-'} (${l.durationMs || 0}ms):`);
        console.log(JSON.stringify(parsed, null, 2));
      }
    }
  } catch (err) {
    console.error('Error querying database:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

queryDb();
