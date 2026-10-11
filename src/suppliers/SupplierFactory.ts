import { ISupplierAdapter } from './ISupplierAdapter';
import { RezekiShopAdapter } from './adapters/RezekiShop.adapter';
import { PrimeDigitalAdapter } from './adapters/PrimeDigital.adapter';
import { DigitalAIStoreAdapter } from './adapters/DigitalAIStore.adapter';
import { Product } from './types';

class SupplierFactory {
  private adapters = new Map<string, ISupplierAdapter>();

  constructor() {
    this.register(new RezekiShopAdapter());
    this.register(new PrimeDigitalAdapter());
    this.register(new DigitalAIStoreAdapter());
  }

  public register(adapter: ISupplierAdapter) {
    this.adapters.set(adapter.code.toUpperCase(), adapter);
  }

  getAdapter(code: string): ISupplierAdapter {
    const adapter = this.adapters.get(code.toUpperCase());
    if (!adapter) {
      throw new Error(`Supplier adapter not found for code: ${code}`);
    }
    return adapter;
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

  /**
   * P2 Foundation: Query all registered suppliers in parallel and sort by stock availability & price.
   * Useful for agentic autonomous procurement.
   */
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

    // Sort by price ascending (in future FX converter can normalize currency if needed)
    candidates.sort((a, b) => (a.product.price ?? Infinity) - (b.product.price ?? Infinity));
    return candidates[0];
  }
}

export const supplierFactory = new SupplierFactory();
