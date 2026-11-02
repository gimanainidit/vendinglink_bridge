import { prisma } from '../src/db';
import { retryMappingSync } from '../src/services/mappingService';
import { getVendingLinkProductById } from '../src/vendinglink/vendingLinkClient';

// Syncs existing ProductMapping rows to the Storefront. Run before STOREFRONT_GATE_ENABLED=true.
// Usage: npx tsx scripts/backfillMappingSync.ts [--dry-run]
const backfill = async () => {
  const dryRun = process.argv.includes('--dry-run');
  const mappings = await prisma.productMapping.findMany({ where: { storefrontSyncedAt: null } });
  console.log(`${mappings.length} unsynced mapping(s)${dryRun ? ' (dry run, nothing is written)' : ''}`);

  let synced = 0;
  const failed: string[] = [];

  for (const m of mappings) {
    const label = `${m.supplierCode}/${m.supplierProductId} -> ${m.vlProductId}`;

    const lookup = await getVendingLinkProductById(m.vlProductId);
    if (lookup.status !== 'found') {
      failed.push(`${label}: ${lookup.status === 'not_found' ? 'not in catalog' : lookup.error}`);
      continue;
    }

    if (dryRun) {
      synced++;
      continue;
    }

    const result = await retryMappingSync(m.supplierCode, m.supplierProductId);
    if (result.synced) {
      synced++;
    } else {
      failed.push(`${label}: ${result.syncError}`);
    }
  }

  console.log(`${dryRun ? 'Would sync' : 'Synced'}: ${synced}, needs attention: ${failed.length}`);
  failed.forEach((line) => console.log(`  - ${line}`));
};

backfill()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
