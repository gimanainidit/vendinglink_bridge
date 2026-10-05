import { ISupplierAdapter } from './ISupplierAdapter';
import { RezekiShopAdapter } from './adapters/RezekiShop.adapter';
// import { MockAdapter } from './adapters/Mock.adapter';

class SupplierFactory {
  private adapters = new Map<string, ISupplierAdapter>();

  constructor() {
    this.register(new RezekiShopAdapter());
    // this.register(new MockAdapter());
  }

  private register(adapter: ISupplierAdapter) {
    this.adapters.set(adapter.code.toUpperCase(), adapter);
  }

  getAdapter(code: string): ISupplierAdapter {
    const adapter = this.adapters.get(code.toUpperCase());
    if (!adapter) {
      throw new Error(`Supplier adapter not found for code: ${code}`);
    }
    return adapter;
  }
}

export const supplierFactory = new SupplierFactory();
