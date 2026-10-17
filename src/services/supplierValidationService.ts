import { prisma } from '../db';
import { decryptCredentials } from '../lib/crypto';
import { GenericRestAdapter, GenericSupplierDescriptor } from '../suppliers/adapters/GenericRestAdapter';
import { supplierFactory } from '../suppliers/SupplierFactory';
import { adapterBuildService } from './adapterBuildService';
import { logger } from '../lib/logger';

export interface SupplierValidationResult {
  success: boolean;
  code: string;
  balance?: number;
  productCount?: number;
  sampleProducts?: { id: string; name: string; price?: number; availability: string }[];
  error?: string;
  checkedAt: string;
}

export class SupplierValidationService {
  /**
   * Dry-run validates a supplier by executing live balance check and product list parsing.
   */
  async validateAdapter(adapter: GenericRestAdapter): Promise<SupplierValidationResult> {
    const checkedAt = new Date().toISOString();
    try {
      // 1. Balance verification
      const balance = await adapter.getBalance();

      // 2. Product list parsing verification
      const products = await adapter.getProductList();

      const sampleProducts = products.slice(0, 5).map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        availability: p.availability,
      }));

      return {
        success: true,
        code: adapter.code,
        balance,
        productCount: products.length,
        sampleProducts,
        checkedAt,
      };
    } catch (err: any) {
      return {
        success: false,
        code: adapter.code,
        error: err.message || 'Unknown validation failure',
        checkedAt,
      };
    }
  }

  /**
   * Validates an existing supplier record in DB and updates its status accordingly.
   */
  async validateSupplier(code: string): Promise<SupplierValidationResult> {
    const upperCode = code.toUpperCase();
    const sup = await prisma.supplier.findUnique({
      where: { code: upperCode },
    });

    if (!sup) {
      return {
        success: false,
        code: upperCode,
        error: `Supplier ${upperCode} not found in database`,
        checkedAt: new Date().toISOString(),
      };
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

      const result = await this.validateAdapter(adapter);

      if (result.success) {
        const updated = await prisma.supplier.update({
          where: { code: upperCode },
          data: {
            status: 'ACTIVE',
            lastError: null,
          },
        });
        supplierFactory.registerFromRecord(updated);
        logger.info({ code: upperCode, balance: result.balance }, 'Supplier validated successfully and marked ACTIVE');
      } else {
        await prisma.supplier.update({
          where: { code: upperCode },
          data: {
            status: 'NEEDS_REVIEW',
            lastError: result.error,
          },
        });
        supplierFactory.unregister(upperCode);
        logger.warn({ code: upperCode, err: result.error }, 'Supplier validation failed and marked NEEDS_REVIEW');

        // Automatically trigger Hermes Agent adapter builder pipeline (BR-P2b-6)
        adapterBuildService.createBuildJob(upperCode).catch((e: any) => {
          logger.warn({ err: e.message, code: upperCode }, 'Failed to auto-enqueue Hermes adapter build job');
        });
      }

      return result;
    } catch (err: any) {
      const errorMsg = `Decryption or adapter creation error: ${err.message}`;
      await prisma.supplier.update({
        where: { code: upperCode },
        data: {
          status: 'NEEDS_REVIEW',
          lastError: errorMsg,
        },
      });
      supplierFactory.unregister(upperCode);
      return {
        success: false,
        code: upperCode,
        error: errorMsg,
        checkedAt: new Date().toISOString(),
      };
    }
  }
}

export const supplierValidationService = new SupplierValidationService();
