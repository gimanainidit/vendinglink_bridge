import { ISupplierAdapter } from './ISupplierAdapter';
import { RezekiShopAdapter } from './adapters/RezekiShop.adapter';
import { PrimeDigitalAdapter } from './adapters/PrimeDigital.adapter';
import { DigitalAIStoreAdapter } from './adapters/DigitalAIStore.adapter';
import { GenericRestAdapter } from './adapters/GenericRestAdapter';
import { Product } from './types';
import { prisma } from '../db';
import { decryptCredentials } from '../lib/crypto';
import { logger } from '../lib/logger';
import { retrieveCandidates } from './candidateRetriever';
import { matchBestOffer } from '../services/hermesSemanticMatcher';

class SupplierFactory {
  private adapters = new Map<string, ISupplierAdapter>();
  private builtInAdapters = new Set<string>(['RZK', 'PDA', 'DAI']);
  private pausedBuiltIns = new Set<string>();

  constructor() {
    this.registerBuiltInAdapters();
  }

  private registerBuiltInAdapters() {
    try {
      this.register(new RezekiShopAdapter());
    } catch (e: any) {
      logger.warn({ err: e.message }, 'RezekiShopAdapter fallback not configured via env');
    }
    try {
      this.register(new PrimeDigitalAdapter());
    } catch (e: any) {
      logger.warn({ err: e.message }, 'PrimeDigitalAdapter not configured via env');
    }
    try {
      this.register(new DigitalAIStoreAdapter());
    } catch (e: any) {
      logger.warn({ err: e.message }, 'DigitalAIStoreAdapter not configured via env');
    }
  }

  public register(adapter: ISupplierAdapter) {
    this.adapters.set(adapter.code.toUpperCase(), adapter);
  }

  public unregister(code: string) {
    const upper = code.toUpperCase();
    if (!this.builtInAdapters.has(upper)) {
      this.adapters.delete(upper);
    }
  }

  public isBuiltIn(code: string): boolean {
    return this.builtInAdapters.has(code.toUpperCase());
  }

  public setBuiltInStatus(code: string, status: 'ACTIVE' | 'PAUSED') {
    const upper = code.toUpperCase();
    if (!this.builtInAdapters.has(upper)) return;
    if (status === 'PAUSED') {
      this.pausedBuiltIns.add(upper);
    } else {
      this.pausedBuiltIns.delete(upper);
    }
    logger.info({ code: upper, status }, 'Built-in adapter status updated');
  }

  public getBuiltInStatus(code: string): 'ACTIVE' | 'PAUSED' {
    const upper = code.toUpperCase();
    if (!this.builtInAdapters.has(upper)) return 'ACTIVE';
    return this.pausedBuiltIns.has(upper) ? 'PAUSED' : 'ACTIVE';
  }

  public isAdapterActive(code: string): boolean {
    const upper = code.toUpperCase();
    if (this.builtInAdapters.has(upper)) {
      return this.adapters.has(upper) && !this.pausedBuiltIns.has(upper);
    }
    return this.adapters.has(upper);
  }

  /**
   * Loads all ACTIVE suppliers from the database and instantiates GenericRestAdapter.
   * Also restores persisted status for Built-in adapters.
   */
  async loadFromDatabase(): Promise<void> {
    try {
      // 1. Restore status overrides for Built-in adapters
      const builtInOverrides = await prisma.supplier.findMany({
        where: {
          code: { in: Array.from(this.builtInAdapters) },
        },
      });

      for (const rec of builtInOverrides) {
        if (rec.status === 'PAUSED') {
          this.pausedBuiltIns.add(rec.code.toUpperCase());
        } else if (rec.status === 'ACTIVE') {
          this.pausedBuiltIns.delete(rec.code.toUpperCase());
        }
      }

      // 2. Load dynamic suppliers
      const activeSuppliers = await prisma.supplier.findMany({
        where: {
          status: 'ACTIVE',
          authType: { not: 'BUILTIN' },
        },
      });

      for (const sup of activeSuppliers) {
        try {
          const credentials = decryptCredentials(sup.credentialsEnc);
          const adapter = new GenericRestAdapter({
            code: sup.code,
            displayName: sup.displayName,
            baseUrl: sup.baseUrl,
            authType: sup.authType,
            credentials,
            descriptor: sup.descriptor,
          });
          this.register(adapter);
        } catch (err: any) {
          logger.error({ err, code: sup.code }, 'Failed to instantiate GenericRestAdapter from DB');
        }
      }
      logger.info(
        { count: activeSuppliers.length, pausedBuiltIns: Array.from(this.pausedBuiltIns) },
        'Suppliers and built-in statuses loaded from database'
      );
    } catch (err: any) {
      logger.error({ err }, 'Error querying suppliers from database in loadFromDatabase');
    }
  }

  /**
   * Registers or updates an adapter dynamically from a Supplier model record.
   */
  registerFromRecord(sup: {
    code: string;
    displayName: string;
    baseUrl: string;
    authType: string;
    credentialsEnc: string;
    descriptor: string;
    status: string;
  }): ISupplierAdapter | null {
    if (sup.status !== 'ACTIVE') {
      this.unregister(sup.code);
      return null;
    }

    try {
      const credentials = decryptCredentials(sup.credentialsEnc);
      const adapter = new GenericRestAdapter({
        code: sup.code,
        displayName: sup.displayName,
        baseUrl: sup.baseUrl,
        authType: sup.authType,
        credentials,
        descriptor: sup.descriptor,
      });
      this.register(adapter);
      return adapter;
    } catch (err: any) {
      logger.error({ err, code: sup.code }, 'Failed to register supplier from record');
      return null;
    }
  }

  getAdapter(code: string): ISupplierAdapter {
    const adapter = this.adapters.get(code.toUpperCase());
    if (!adapter) {
      throw new Error(`Supplier adapter not found for code: ${code}`);
    }
    return adapter;
  }

  hasAdapter(code: string, includePaused = false): boolean {
    const upper = code.toUpperCase();
    if (!this.adapters.has(upper)) return false;
    if (includePaused) return true;
    return this.isAdapterActive(upper);
  }

  getAllAdapters(includePaused = false): ISupplierAdapter[] {
    return Array.from(this.adapters.values()).filter((a) => {
      if (includePaused) return true;
      return !this.pausedBuiltIns.has(a.code.toUpperCase());
    });
  }

  listSuppliers(): { code: string; displayName: string }[] {
    return this.getAllAdapters().map((a) => ({
      code: a.code,
      displayName: a.displayName,
    }));
  }

  async findBestOffer(
    query: string,
    maxBudget?: number | null
  ): Promise<{ adapter: ISupplierAdapter; product: Product; confidence?: number; reason?: string } | null> {
    const adapters = this.getAllAdapters();
    const candidatePool = await retrieveCandidates(adapters, query);

    if (candidatePool.length === 0) {
      return null;
    }

    const matchResult = await matchBestOffer(query, candidatePool, maxBudget);
    if (!matchResult.matched || !matchResult.candidate) {
      return null;
    }

    return {
      adapter: matchResult.candidate.adapter,
      product: matchResult.candidate.product,
      confidence: matchResult.confidence,
      reason: matchResult.reason,
    };
  }
}

export const supplierFactory = new SupplierFactory();
