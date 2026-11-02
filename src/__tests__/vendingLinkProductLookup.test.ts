import { describe, it, expect, vi, afterEach } from 'vitest';
import axios from 'axios';
import { env } from '../config/env';
import { getVendingLinkProductById } from '../vendinglink/vendingLinkClient';

describe('getVendingLinkProductById', () => {
  afterEach(() => vi.restoreAllMocks());

  const respondWith = (products: unknown) => vi.spyOn(axios, 'get').mockResolvedValue({ data: { products } });
  const catalogOf = (size: number) => Array.from({ length: size }, (_, i) => ({ id: `p${i}` }));

  it('finds a product in the catalog', async () => {
    respondWith([{ id: 'a', name: 'A' }]);
    expect(await getVendingLinkProductById('a')).toEqual({ status: 'found', product: { id: 'a', name: 'A' } });
  });

  it('reports not_found when a partial page has no match', async () => {
    respondWith(catalogOf(3));
    expect(await getVendingLinkProductById('missing')).toEqual({ status: 'not_found' });
  });

  it('is inconclusive when a full page has no match', async () => {
    respondWith(catalogOf(500));
    expect((await getVendingLinkProductById('missing')).status).toBe('unavailable');
  });

  it('is unavailable on a malformed response or a network error', async () => {
    respondWith('nope');
    expect((await getVendingLinkProductById('a')).status).toBe('unavailable');

    vi.spyOn(axios, 'get').mockRejectedValue(new Error('down'));
    expect(await getVendingLinkProductById('a')).toEqual({ status: 'unavailable', error: 'down' });
  });

  it('queries only the configured Storefront, with no fallback host', async () => {
    const get = vi.spyOn(axios, 'get').mockRejectedValue(new Error('down'));

    await getVendingLinkProductById('a');

    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe(`${env.VENDINGLINK_URL}/api/bridge/products`);
  });
});
