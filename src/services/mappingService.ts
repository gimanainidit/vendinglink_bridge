import { prisma } from '../db';
import { env } from '../config/env';
import {
  getVendingLinkProductById,
  syncProductMappingToVendingLink,
} from '../vendinglink/vendingLinkClient';

export interface SyncState {
  synced: boolean;
  syncError?: string;
}

export type SaveMappingResult =
  | ({ ok: true; created: boolean } & SyncState)
  | { ok: false; reason: 'not_in_catalog' | 'storefront_unavailable'; error?: string };

export type GateResult =
  | { ok: true; vlProductId: string }
  | {
      ok: false;
      reason: 'unmapped' | 'disabled' | 'not_synced' | 'not_in_catalog' | 'storefront_unavailable';
      error?: string;
    };

const syncAndRecord = async (
  supplierCode: string,
  supplierProductId: string,
  vlProductId: string
): Promise<SyncState> => {
  const result = await syncProductMappingToVendingLink(supplierCode, supplierProductId, vlProductId);
  await prisma.productMapping.update({
    where: { supplierCode_supplierProductId: { supplierCode, supplierProductId } },
    data: result.success
      ? { storefrontSyncedAt: new Date(), lastSyncError: null }
      : { storefrontSyncedAt: null, lastSyncError: result.error ?? 'Unknown sync error' },
  });
  return result.success ? { synced: true } : { synced: false, syncError: result.error };
};

/**
 * Single write path for product mappings: Bridge first, then the Storefront.
 * A failed sync keeps the Bridge row, flagged as unsynced, so it can be retried.
 * Set verifyCatalog for IDs typed by hand; IDs picked from the catalog are already known good.
 */
export const saveMapping = async (input: {
  supplierCode: string;
  supplierProductId: string;
  vlProductId: string;
  displayName?: string;
  verifyCatalog?: boolean;
}): Promise<SaveMappingResult> => {
  const { supplierCode, supplierProductId, vlProductId, displayName, verifyCatalog } = input;

  if (verifyCatalog) {
    const lookup = await getVendingLinkProductById(vlProductId);
    if (lookup.status === 'not_found') return { ok: false, reason: 'not_in_catalog' };
    if (lookup.status === 'unavailable') {
      return { ok: false, reason: 'storefront_unavailable', error: lookup.error };
    }
  }

  const where = { supplierCode_supplierProductId: { supplierCode, supplierProductId } };
  const existing = await prisma.productMapping.findUnique({ where });

  await prisma.productMapping.upsert({
    where,
    update: { vlProductId, displayName, storefrontSyncedAt: null, lastSyncError: null },
    create: { supplierCode, supplierProductId, vlProductId, displayName },
  });

  const sync = await syncAndRecord(supplierCode, supplierProductId, vlProductId);
  return { ok: true, created: !existing, ...sync };
};

export const retryMappingSync = async (
  supplierCode: string,
  supplierProductId: string
): Promise<SyncState> => {
  const mapping = await prisma.productMapping.findUnique({
    where: { supplierCode_supplierProductId: { supplierCode, supplierProductId } },
  });
  if (!mapping) return { synced: false, syncError: 'Mapping not found' };
  return syncAndRecord(supplierCode, supplierProductId, mapping.vlProductId);
};

/**
 * Decides whether a supplier product may be bought from Telegram.
 * Fails closed: the supplier is charged before delivery, so an unreachable Storefront blocks the purchase.
 */
export const checkPurchasable = async (
  supplierCode: string,
  supplierProductId: string
): Promise<GateResult> => {
  const mapping = await prisma.productMapping.findUnique({
    where: { supplierCode_supplierProductId: { supplierCode, supplierProductId } },
  });

  if (!mapping) return { ok: false, reason: 'unmapped' };
  if (!mapping.enabled) return { ok: false, reason: 'disabled' };
  if (!env.STOREFRONT_GATE_ENABLED) return { ok: true, vlProductId: mapping.vlProductId };

  if (!mapping.storefrontSyncedAt) {
    return { ok: false, reason: 'not_synced', error: mapping.lastSyncError ?? undefined };
  }

  const lookup = await getVendingLinkProductById(mapping.vlProductId);
  if (lookup.status === 'not_found') return { ok: false, reason: 'not_in_catalog' };
  if (lookup.status === 'unavailable') {
    return { ok: false, reason: 'storefront_unavailable', error: lookup.error };
  }

  return { ok: true, vlProductId: mapping.vlProductId };
};
