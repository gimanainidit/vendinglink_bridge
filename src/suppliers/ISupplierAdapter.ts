import { Product, PurchaseParams, PurchaseResult } from './types';

export class SupplierRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplierRejectedError';
  }
}

export class SupplierFailedRefundedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplierFailedRefundedError';
  }
}

export class SupplierUnknownOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplierUnknownOutcomeError';
  }
}

export interface ISupplierAdapter {
  code: string;
  displayName: string;

  getProductList(search?: string): Promise<Product[]>;
  getProduct(id: string): Promise<Product | null>;
  purchaseProduct(params: PurchaseParams): Promise<PurchaseResult>;
  findRecentOrder(match: { productId: string; qty: number; since: Date }): Promise<PurchaseResult | null>;
  getBalance(): Promise<number>;
}
