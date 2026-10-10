export interface Product {
  id: string;
  name: string;
  price?: number;
  stock?: number;
  availability: 'in_stock' | 'out_of_stock';
  requiresEmail: boolean;
  description: string;
  /** Category slug from supplier API — forwarded as-is if available */
  categorySlug?: string;
  /** Additional tags or labels from supplier API */
  tags?: string[];
}

export interface PurchaseResult {
  orderId?: string;
  deliveredKeys: string[];
  balance: {
    before?: number;
    deducted?: number;
    refunded?: number;
    after?: number;
  };
}

export interface PurchaseParams {
  productId: string;
  qty: number;
  emails?: string[];
  transactionId: string; // for logging/audit
}
