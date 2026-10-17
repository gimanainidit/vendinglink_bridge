import { ISupplierAdapter } from './ISupplierAdapter';
import { Product } from './types';
import { logger } from '../lib/logger';

export interface CandidateProduct {
  adapter: ISupplierAdapter;
  product: Product;
  supplierCode: string;
}

/**
 * Retrieves candidate products across all active suppliers using multi-token queries.
 * Prevents literal search mismatches (e.g. "test products" vs "Test Api product").
 */
export async function retrieveCandidates(
  adapters: ISupplierAdapter[],
  query: string
): Promise<CandidateProduct[]> {
  const cleanQuery = query.trim().toLowerCase();
  const tokens = cleanQuery
    .split(/\s+/)
    .map((t) => t.replace(/[^a-zA-Z0-9]/g, ''))
    .filter((t) => t.length >= 2);

  const searchTerms = Array.from(new Set([cleanQuery, ...tokens]));
  const candidateMap = new Map<string, CandidateProduct>();

  await Promise.allSettled(
    adapters.map(async (adapter) => {
      try {
        // 1. Try querying with each search term
        const fetchedLists: Product[][] = [];
        for (const term of searchTerms) {
          try {
            const list = await adapter.getProductList(term);
            if (Array.isArray(list) && list.length > 0) {
              fetchedLists.push(list);
            }
          } catch (err: any) {
            logger.debug(
              { supplier: adapter.code, term, err: err.message },
              'Candidate term search failed, continuing'
            );
          }
        }

        // 2. If term search returned nothing, fallback to base catalog list
        if (fetchedLists.length === 0) {
          try {
            const allProducts = await adapter.getProductList();
            if (Array.isArray(allProducts) && allProducts.length > 0) {
              fetchedLists.push(allProducts);
            }
          } catch (err: any) {
            logger.debug(
              { supplier: adapter.code, err: err.message },
              'Base catalog retrieval failed'
            );
          }
        }

        // 3. Deduplicate and collect in-stock items
        for (const list of fetchedLists) {
          for (const prod of list) {
            if (prod.availability === 'in_stock' && (prod.stock === undefined || prod.stock > 0)) {
              const key = `${adapter.code}:${prod.id}`.toUpperCase();
              if (!candidateMap.has(key)) {
                candidateMap.set(key, {
                  adapter,
                  product: prod,
                  supplierCode: adapter.code,
                });
              }
            }
          }
        }
      } catch (err: any) {
        logger.warn({ supplier: adapter.code, err: err.message }, 'Failed retrieving candidates from supplier');
      }
    })
  );

  const candidates = Array.from(candidateMap.values());
  logger.info(
    { query, totalCandidates: candidates.length },
    'Retrieved candidate pool across suppliers for semantic evaluation'
  );

  return candidates;
}
