import { ISupplierAdapter } from './ISupplierAdapter';
import { RezekiShopAdapter } from './adapters/RezekiShop.adapter';
import { PrimeDigitalAdapter } from './adapters/PrimeDigital.adapter';
import { DigitalAIStoreAdapter } from './adapters/DigitalAIStore.adapter';
import { GenericRestAdapter } from './adapters/GenericRestAdapter';
import { Product } from './types';
import { prisma } from '../db';
import { decryptCredentials } from '../lib/crypto';
import { logger } from '../lib/logger';

class SupplierFactory {
  private adapters = new Map<string, ISupplierAdapter>();
  private builtInAdapters = new Set<string>(['RZK', 'PDA', 'DAI']);

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

  /**
   * Loads all ACTIVE suppliers from the database and instantiates GenericRestAdapter.
   */
  async loadFromDatabase(): Promise<void> {
    try {
      const activeSuppliers = await prisma.supplier.findMany({
        where: { status: 'ACTIVE' },
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
      logger.info({ count: activeSuppliers.length }, 'Suppliers loaded from database');
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

  hasAdapter(code: string): boolean {
    return this.adapters.has(code.toUpperCase());
  }

  getAllAdapters(): ISupplierAdapter[] {
    return Array.from(this.adapters.values());
  }

  listSuppliers(): { code: string; displayName: string }[] {
    return this.getAllAdapters().map((a) => ({
      code: a.code,
      displayName: a.displayName,
    }));
  }

  async findBestOffer(query: string): Promise<{ adapter: ISupplierAdapter; product: Product } | null> {
    const adapters = this.getAllAdapters();
    const results = await Promise.allSettled(
      adapters.map(async (adapter) => {
        const products = await adapter.getProductList(query);
        const inStock = products.filter((p) => p.availability === 'in_stock' && (p.stock === undefined || p.stock > 0));
        return inStock.map((product) => ({ adapter, product }));
      })
    );

    const candidates: { adapter: ISupplierAdapter; product: Product }[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        candidates.push(...r.value);
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => (a.product.price ?? Infinity) - (b.product.price ?? Infinity));
    return candidates[0];
  }
}

export const supplierFactory = new SupplierFactory();
