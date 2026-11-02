import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mappings: new Map<string, any>(),
  adapter: {
    code: 'RZK',
    displayName: 'Rezeki Shop',
    getProductList: vi.fn(),
    getProduct: vi.fn(),
    getBalance: vi.fn(),
  },
  lookup: vi.fn(),
  sync: vi.fn(),
  createTx: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock('../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env')>();
  return { env: { ...actual.env, MAX_BUY_QTY: 10, STOREFRONT_GATE_ENABLED: false } };
});

vi.mock('../db', () => {
  const key = (w: any) =>
    `${w.supplierCode_supplierProductId.supplierCode}|${w.supplierCode_supplierProductId.supplierProductId}`;
  return {
    prisma: {
      productMapping: {
        findUnique: vi.fn(async ({ where }: any) => mocks.mappings.get(key(where)) ?? null),
        upsert: vi.fn(async ({ where, update, create }: any) => {
          const current = mocks.mappings.get(key(where));
          const next = current ? { ...current, ...update } : { enabled: true, ...create };
          mocks.mappings.set(key(where), next);
          return next;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const next = { ...mocks.mappings.get(key(where)), ...data };
          mocks.mappings.set(key(where), next);
          return next;
        }),
      },
    },
  };
});

vi.mock('../suppliers/SupplierFactory', () => ({
  supplierFactory: { getAdapter: () => mocks.adapter },
}));

vi.mock('../vendinglink/vendingLinkClient', () => ({
  fetchVendingLinkProducts: vi.fn(async () => ({ success: true, products: [], url: '' })),
  getVendingLinkProductById: mocks.lookup,
  syncProductMappingToVendingLink: mocks.sync,
}));

vi.mock('../services/orchestrator', () => ({ createPendingTransaction: mocks.createTx }));
vi.mock('../queues/queues', () => ({ supplierOrderQueue: { add: mocks.queueAdd } }));
vi.mock('../services/agentGuardrailService', () => ({ agentGuardrailService: {} }));
vi.mock('../services/adapterBuildService', () => ({ adapterBuildService: {} }));

import { env } from '../config/env';
import { checkPurchasable, saveMapping } from '../services/mappingService';
import { handleCallbackQuery } from '../telegram/callbacks/confirmBuy';
import { formatMoney } from '../telegram/format';
import { createList, LIST_TTL_MS, parseListInput, renderListPage, renderProductCard } from '../telegram/listView';
import { handleTextMessage } from '../telegram/router';
import { fetchVendingLinkProducts } from '../vendinglink/vendingLinkClient';

const product =(i: number, overrides: Record<string, unknown> = {}) => ({
  id: `prod_${i}`,
  name: `Produk ${i}`,
  price: 1000 * i,
  availability: 'in_stock',
  requiresEmail: false,
  description: '',
  currency: 'IDR',
  ...overrides,
});

const addMapping = (id: string, overrides: Record<string, unknown> = {}) =>
  mocks.mappings.set(`RZK|${id}`, {
    supplierCode: 'RZK',
    supplierProductId: id,
    vlProductId: 'vl_1',
    enabled: true,
    storefrontSyncedAt: new Date(),
    ...overrides,
  });

const makeCtx = () => {
  const ctx: any = {
    session: {},
    from: { id: 42 },
    reply: vi.fn(async () => ({})),
    editMessageText: vi.fn(async () => ({})),
    editMessageReplyMarkup: vi.fn(async () => ({})),
    answerCbQuery: vi.fn(async () => true),
  };
  ctx.say = async (text: string) => {
    ctx.message = { text };
    ctx.callbackQuery = undefined;
    await handleTextMessage(ctx);
  };
  ctx.tap = async (data: string) => {
    ctx.callbackQuery = { data };
    await handleCallbackQuery(ctx);
  };
  ctx.lastReply = () => ctx.reply.mock.calls.at(-1);
  ctx.lastButtons = () => ctx.lastReply()[1].reply_markup.inline_keyboard.flat();
  return ctx;
};

const confirmData = (ctx: any) =>
  ctx.lastButtons().find((b: any) => b.callback_data.startsWith('buy_ok_')).callback_data;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchVendingLinkProducts).mockResolvedValue({ success: true, products: [], url: '' });
  mocks.mappings.clear();
  (env as any).STOREFRONT_GATE_ENABLED = false;
  mocks.adapter.code = 'RZK';
  mocks.adapter.getBalance.mockResolvedValue(1_000_000);
  mocks.adapter.getProductList.mockResolvedValue(Array.from({ length: 23 }, (_, i) => product(i + 1)));
  mocks.adapter.getProduct.mockImplementation(async (id: string) => product(Number(id.split('_')[1])));
  mocks.lookup.mockResolvedValue({ status: 'found', product: { id: 'vl_1' } });
  mocks.sync.mockResolvedValue({ success: true });
  mocks.createTx.mockResolvedValue({ id: 'tx1', transactionId: 'BRG-1' });
});

describe('list view', () => {
  it('parses typed picks', () => {
    expect(parseListInput('3')).toEqual({ index: 2, qty: undefined });
    expect(parseListInput('12')).toEqual({ index: 11, qty: undefined });
    expect(parseListInput('3 2')).toEqual({ index: 2, qty: 2 });
    expect(parseListInput('3x2')).toEqual({ index: 2, qty: 2 });
    expect(parseListInput('3 X2')).toEqual({ index: 2, qty: 2 });
    expect(parseListInput('hello')).toBeNull();
    expect(parseListInput('3 x')).toBeNull();
  });

  it('keeps numbering continuous across pages and keeps navigation in range', () => {
    const list = createList('RZK', 'Rezeki', Array.from({ length: 23 }, (_, i) => product(i + 1)) as any);

    const second = renderListPage(list, 1);
    expect(second.text).toContain('11. ✅ Produk 11');
    expect(second.text).toContain('(hal 2/3)');

    const flat = renderListPage(list, 2).keyboard.flat();
    expect(flat.map((b) => b.text)).toContain('23');
    expect(flat.map((b) => b.text)).not.toContain('▶️');
  });

  it('keeps every callback inside the Telegram 64-byte limit', () => {
    const list = createList('RZK', 'Rezeki', [product(1, { id: 'x'.repeat(200) })] as any);
    const buttons = [
      ...renderListPage(list, 0).keyboard.flat(),
      ...renderProductCard(list, 0, true, 10).keyboard.flat(),
    ];
    for (const b of buttons) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });

  it('escapes supplier text and does not offer qty above the limit', () => {
    const list = createList('RZK', 'R&D', [product(1, { name: '<b>x</b>' })] as any);
    expect(renderListPage(list, 0).text).toContain('&lt;b&gt;x&lt;/b&gt;');
    const labels = renderProductCard(list, 0, true, 2).keyboard.flat().map((b) => b.text);
    expect(labels).toContain('Qty 2');
    expect(labels).not.toContain('Qty 3');
  });

  it('formats money by currency, including USD suppliers other than PDA', () => {
    expect(formatMoney(1.5, 'USD')).toBe('$1.50 USD');
    expect(formatMoney(25000, 'IDR')).toBe('Rp25.000');
  });
});

describe('/list to purchase flow', () => {
  it('buys through tap number, tap qty, confirm', async () => {
    addMapping('prod_3');
    const ctx = makeCtx();

    await ctx.say('/list rzk');
    const listId = ctx.session.pendingList.listId;
    await ctx.tap(`list_pick_${listId}_2`);
    expect(ctx.session.state).toBe('AWAITING_QTY');

    await ctx.tap(`list_qty_${listId}_2_2`);
    await ctx.tap(confirmData(ctx));

    expect(mocks.createTx).toHaveBeenCalledWith('RZK', 'prod_3', 2, undefined, '42');
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
  });

  it('accepts a typed number followed by a typed qty', async () => {
    addMapping('prod_3');
    const ctx = makeCtx();

    await ctx.say('/list RZK');
    await ctx.say('3');
    await ctx.say('4');
    await ctx.tap(confirmData(ctx));

    expect(mocks.createTx).toHaveBeenCalledWith('RZK', 'prod_3', 4, undefined, '42');
  });

  it('accepts the typed shortcut "3 x2"', async () => {
    addMapping('prod_3');
    const ctx = makeCtx();

    await ctx.say('/list RZK');
    await ctx.say('3 x2');

    expect(ctx.session.pendingBuy).toMatchObject({ productId: 'prod_3', qty: 2 });
  });

  it('rejects out-of-range numbers and quantities', async () => {
    const ctx = makeCtx();
    await ctx.say('/list RZK');

    await ctx.say('99');
    expect(ctx.lastReply()[0]).toContain('antara 1 dan 23');

    await ctx.say('3 x11');
    expect(ctx.lastReply()[0]).toContain('antara 1 dan 10');
    expect(ctx.session.pendingBuy).toBeUndefined();
  });

  it('refuses to select an out-of-stock item, by tap and by typing', async () => {
    mocks.adapter.getProductList.mockResolvedValue([product(1, { availability: 'out_of_stock' })]);
    const ctx = makeCtx();
    await ctx.say('/list RZK');

    await ctx.tap(`list_pick_${ctx.session.pendingList.listId}_0`);
    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('habis'), { show_alert: true });

    await ctx.say('1');
    expect(ctx.lastReply()[0]).toContain('habis');
    expect(ctx.session.state).toBeUndefined();
  });

  it('never resolves a button from an older list against the current list', async () => {
    const ctx = makeCtx();
    await ctx.say('/list RZK');
    const oldListId = ctx.session.pendingList.listId;
    await ctx.say('/list RZK gemini');

    await ctx.tap(`list_pick_${oldListId}_0`);

    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('kedaluwarsa'), { show_alert: true });
    expect(ctx.session.state).toBeUndefined();
  });

  it('expires the list after its TTL', async () => {
    const ctx = makeCtx();
    await ctx.say('/list RZK');
    ctx.session.pendingList.createdAt -= LIST_TTL_MS + 1;

    await ctx.say('3');

    expect(ctx.lastReply()[0]).toContain('Unrecognized input');
  });

  it('treats a number as unrecognized without an active list', async () => {
    const ctx = makeCtx();
    await ctx.say('3');
    expect(ctx.lastReply()[0]).toContain('Unrecognized input');
  });

  it('collects activation emails before confirming a list purchase', async () => {
    addMapping('prod_1');
    mocks.adapter.getProduct.mockResolvedValue(product(1, { requiresEmail: true }));
    const ctx = makeCtx();

    await ctx.say('/list RZK');
    await ctx.say('1 x1');
    expect(ctx.session.state).toBe('AWAITING_EMAIL');

    await ctx.say('a@example.com');
    await ctx.tap(confirmData(ctx));

    expect(mocks.createTx).toHaveBeenCalledWith('RZK', 'prod_1', 1, ['a@example.com'], '42');
  });

  it('/cancel clears the list and qty state', async () => {
    const ctx = makeCtx();
    await ctx.say('/list RZK');
    await ctx.say('3');
    await ctx.say('/cancel');

    expect(ctx.session.state).toBeUndefined();
    expect(ctx.session.pendingList).toBeUndefined();
  });
});

describe('purchase safety', () => {
  it('keeps inline /buy emails through confirmation', async () => {
    addMapping('prod_1');
    const ctx = makeCtx();

    await ctx.say('/buy RZK prod_1 1 a@example.com');
    await ctx.tap(confirmData(ctx));

    expect(mocks.createTx).toHaveBeenCalledWith('RZK', 'prod_1', 1, ['a@example.com'], '42');
  });

  it('creates one transaction on a double tap', async () => {
    addMapping('prod_1');
    const ctx = makeCtx();

    await ctx.say('/buy RZK prod_1');
    const data = confirmData(ctx);
    await Promise.all([ctx.tap(data), ctx.tap(data)]);

    expect(mocks.createTx).toHaveBeenCalledTimes(1);
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
  });

  it('ignores a Confirm button from a replaced purchase', async () => {
    addMapping('prod_1');
    addMapping('prod_2');
    const ctx = makeCtx();

    await ctx.say('/buy RZK prod_1');
    const stale = confirmData(ctx);
    await ctx.say('/buy RZK prod_2');
    await ctx.tap(stale);

    expect(mocks.createTx).not.toHaveBeenCalled();
  });

  it('blocks a product with an unknown price', async () => {
    addMapping('prod_1');
    mocks.adapter.getProduct.mockResolvedValue(product(1, { price: undefined }));
    const ctx = makeCtx();

    await ctx.say('/buy RZK prod_1');

    expect(ctx.lastReply()[0]).toContain('Harga');
    expect(ctx.session.pendingBuy).toBeUndefined();
  });

  it('shows a USD total for a USD supplier that is not PDA', async () => {
    addMapping('prod_1', { supplierCode: 'RZK' });
    mocks.adapter.getProduct.mockResolvedValue(product(1, { price: 2, currency: 'USD' }));
    mocks.adapter.getBalance.mockResolvedValue(10);
    const ctx = makeCtx();

    await ctx.say('/buy RZK prod_1');

    expect(ctx.lastReply()[0]).toContain('Total: $2.00 USD');
    expect(ctx.lastReply()[0]).toContain('$10.00 USD → $8.00 USD');
  });

  it('buy_cancel clears the purchase, so its Confirm button stops working', async () => {
    addMapping('prod_1');
    const ctx = makeCtx();

    await ctx.say('/buy RZK prod_1');
    const data = confirmData(ctx);
    await ctx.tap('buy_cancel');
    await ctx.tap(data);

    expect(ctx.session.state).toBeUndefined();
    expect(mocks.createTx).not.toHaveBeenCalled();
  });
});

describe('mapping gate', () => {
  it('hides Confirm for an unmapped product, then resumes after mapping', async () => {
    vi.mocked(fetchVendingLinkProducts).mockResolvedValue({
      success: true,
      url: '',
      products: [{ id: 'vl_9', name: 'Gemini', price: 1000, type: 'digital' }],
    });
    const ctx = makeCtx();

    await ctx.say('/buy RZK prod_1 2');
    expect(ctx.lastButtons().map((b: any) => b.callback_data)).toEqual(['gate_map', 'buy_cancel']);

    await ctx.tap('gate_map');
    await ctx.tap('map_pick_0');
    expect(mocks.sync).toHaveBeenCalledWith('RZK', 'prod_1', 'vl_9');

    const editExtra = ctx.editMessageText.mock.calls.at(-1)[1];
    expect(editExtra.reply_markup.inline_keyboard.flat()[0].callback_data).toBe('gate_retry');

    await ctx.tap('gate_retry');
    await ctx.tap(confirmData(ctx));
    expect(mocks.createTx).toHaveBeenCalledWith('RZK', 'prod_1', 2, undefined, '42');
  });

  it('asks for no emails on a blocked product', async () => {
    mocks.adapter.getProduct.mockResolvedValue(product(1, { requiresEmail: true }));
    const ctx = makeCtx();

    await ctx.say('/buy RZK prod_1');

    expect(ctx.session.state).toBeUndefined();
    expect(ctx.lastReply()[0]).toContain('belum dimapping');
  });

  it('blocks when the product is deactivated between Confirm screen and tap', async () => {
    (env as any).STOREFRONT_GATE_ENABLED = true;
    addMapping('prod_1');
    const ctx = makeCtx();

    await ctx.say('/buy RZK prod_1');
    const data = confirmData(ctx);
    mocks.lookup.mockResolvedValue({ status: 'not_found' });
    await ctx.tap(data);

    expect(mocks.createTx).not.toHaveBeenCalled();
    expect(ctx.lastButtons()[0].callback_data).toBe('gate_map');
  });

  it('retries a failed sync from the gate button', async () => {
    (env as any).STOREFRONT_GATE_ENABLED = true;
    addMapping('prod_1', { storefrontSyncedAt: null, lastSyncError: 'boom' });
    const ctx = makeCtx();

    await ctx.say('/buy RZK prod_1');
    expect(ctx.lastButtons()[0].callback_data).toBe('gate_sync');

    await ctx.tap('gate_sync');

    expect(confirmData(ctx)).toMatch(/^buy_ok_/);
  });

  describe('checkPurchasable', () => {
    it('blocks unmapped and disabled mappings even with the flag off', async () => {
      expect(await checkPurchasable('RZK', 'x')).toEqual({ ok: false, reason: 'unmapped' });

      addMapping('x', { enabled: false });
      expect(await checkPurchasable('RZK', 'x')).toEqual({ ok: false, reason: 'disabled' });
    });

    it('allows a legacy unsynced mapping and skips the Storefront while the flag is off', async () => {
      addMapping('x', { storefrontSyncedAt: null });

      expect(await checkPurchasable('RZK', 'x')).toEqual({ ok: true, vlProductId: 'vl_1' });
      expect(mocks.lookup).not.toHaveBeenCalled();
    });

    it('with the flag on, blocks unsynced, missing and unreachable, and allows the rest', async () => {
      (env as any).STOREFRONT_GATE_ENABLED = true;

      addMapping('x', { storefrontSyncedAt: null, lastSyncError: 'boom' });
      expect(await checkPurchasable('RZK', 'x')).toEqual({ ok: false, reason: 'not_synced', error: 'boom' });

      addMapping('x');
      mocks.lookup.mockResolvedValueOnce({ status: 'not_found' });
      expect(await checkPurchasable('RZK', 'x')).toEqual({ ok: false, reason: 'not_in_catalog' });

      mocks.lookup.mockResolvedValueOnce({ status: 'unavailable', error: 'down' });
      expect(await checkPurchasable('RZK', 'x')).toEqual({
        ok: false,
        reason: 'storefront_unavailable',
        error: 'down',
      });

      expect(await checkPurchasable('RZK', 'x')).toEqual({ ok: true, vlProductId: 'vl_1' });
    });
  });

  describe('saveMapping', () => {
    const input = { supplierCode: 'RZK', supplierProductId: 'x', vlProductId: 'vl_1' };

    it('records a successful sync', async () => {
      expect(await saveMapping(input)).toEqual({ ok: true, created: true, synced: true });
      expect(mocks.mappings.get('RZK|x').storefrontSyncedAt).toBeInstanceOf(Date);
    });

    it('keeps the mapping and records the error when sync fails', async () => {
      mocks.sync.mockResolvedValue({ success: false, error: 'boom' });

      expect(await saveMapping(input)).toEqual({ ok: true, created: true, synced: false, syncError: 'boom' });
      expect(mocks.mappings.get('RZK|x')).toMatchObject({ storefrontSyncedAt: null, lastSyncError: 'boom' });
    });

    it('clears the old sync state when the mapping target changes', async () => {
      addMapping('x', { vlProductId: 'vl_old' });
      mocks.sync.mockResolvedValue({ success: false, error: 'boom' });

      await saveMapping(input);

      expect(mocks.mappings.get('RZK|x')).toMatchObject({ vlProductId: 'vl_1', storefrontSyncedAt: null });
    });

    it('writes nothing for an ID outside the catalog or an unverifiable one', async () => {
      mocks.lookup.mockResolvedValueOnce({ status: 'not_found' });
      expect(await saveMapping({ ...input, verifyCatalog: true })).toEqual({ ok: false, reason: 'not_in_catalog' });

      mocks.lookup.mockResolvedValueOnce({ status: 'unavailable', error: 'down' });
      expect(await saveMapping({ ...input, verifyCatalog: true })).toEqual({
        ok: false,
        reason: 'storefront_unavailable',
        error: 'down',
      });

      expect(mocks.mappings.size).toBe(0);
      expect(mocks.sync).not.toHaveBeenCalled();
    });
  });

  it('/map rejects a hand-typed ID that is not in the catalog', async () => {
    mocks.lookup.mockResolvedValue({ status: 'not_found' });
    const ctx = makeCtx();

    await ctx.say('/map RZK prod_1 typo_id');

    expect(ctx.lastReply()[0]).toContain('tidak ditemukan');
    expect(mocks.mappings.size).toBe(0);
  });
});
