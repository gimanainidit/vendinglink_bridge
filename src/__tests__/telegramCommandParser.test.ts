import { describe, it, expect } from 'vitest';
import { parseCommand } from '../telegram/parser/commandParser';
import { escapeHtml } from '../telegram/router';

describe('Telegram Command Parser & Formatting', () => {
  describe('/buy command parsing', () => {
    it('parses /buy with supplier and product_id only, defaulting qty to 1', () => {
      const res = parseCommand('/buy rzk 6a31035939dc014325da2c66');
      expect(res.error).toBeUndefined();
      expect(res.command).toEqual({
        type: 'buy',
        supplierCode: 'RZK',
        productId: '6a31035939dc014325da2c66',
        qty: 1,
        emails: undefined,
      });
    });

    it('parses /buy with explicit quantity', () => {
      const res = parseCommand('/buy rzk 6a31035939dc014325da2c66 3');
      expect(res.error).toBeUndefined();
      expect(res.command).toEqual({
        type: 'buy',
        supplierCode: 'RZK',
        productId: '6a31035939dc014325da2c66',
        qty: 3,
        emails: undefined,
      });
    });

    it('parses /buy with explicit quantity and emails', () => {
      const res = parseCommand('/buy pda prod_123 2 user1@example.com,user2@example.com');
      expect(res.error).toBeUndefined();
      expect(res.command).toEqual({
        type: 'buy',
        supplierCode: 'PDA',
        productId: 'prod_123',
        qty: 2,
        emails: ['user1@example.com', 'user2@example.com'],
      });
    });

    it('parses /buy with implicit quantity 1 and direct email', () => {
      const res = parseCommand('/buy rzk 6a31035939dc014325da2c66 buyer@example.com');
      expect(res.error).toBeUndefined();
      expect(res.command).toEqual({
        type: 'buy',
        supplierCode: 'RZK',
        productId: '6a31035939dc014325da2c66',
        qty: 1,
        emails: ['buyer@example.com'],
      });
    });

    it('returns usage error if less than 2 arguments after /buy', () => {
      const res = parseCommand('/buy rzk');
      expect(res.command).toBeUndefined();
      expect(res.error).toContain('Usage: /buy <SUPPLIER_CODE> <PRODUCT_ID> [QTY] [emails...]');
    });

    it('rejects invalid quantities', () => {
      const resZero = parseCommand('/buy rzk prod 0');
      expect(resZero.error).toContain('Quantity must be an integer between 1 and');

      const resNegative = parseCommand('/buy rzk prod -5');
      expect(resNegative.error).toContain('Quantity must be an integer between 1 and');

      const resOverMax = parseCommand('/buy rzk prod 99999');
      expect(resOverMax.error).toContain('Quantity must be an integer between 1 and');

      const resNonNumeric = parseCommand('/buy rzk prod notanumber');
      expect(resNonNumeric.error).toContain('Quantity must be an integer between 1 and');
    });

    it('rejects mismatched email count vs quantity', () => {
      const res = parseCommand('/buy rzk prod 2 single@example.com');
      expect(res.error).toContain('Provided 1 emails, but quantity is 2');
    });
  });

  describe('HTML escaping and safe formatting', () => {
    it('escapes &, <, > safely for Telegram HTML parse_mode', () => {
      expect(escapeHtml('AT&T <Phone> & Co.')).toBe('AT&amp;T &lt;Phone&gt; &amp; Co.');
    });

    it('leaves underscores and asterisks untouched for HTML parse_mode', () => {
      const str = 'NEEDS_REVIEW and loc_test1 and *bold*';
      expect(escapeHtml(str)).toBe('NEEDS_REVIEW and loc_test1 and *bold*');
    });

    it('formats unmapped warning safely without entity errors', () => {
      const supplierCode = 'RZK';
      const productId = '6a31035939dc014325da2c66';
      const warning = `⚠️ <b>Produk belum dimapping!</b> Jalankan:\n<code>/map ${escapeHtml(supplierCode)} ${escapeHtml(productId)}</code>\n<i>(Pilih produk VendingLink yang cocok dari tombol)</i>\n`;

      expect(warning).toContain('<code>/map RZK 6a31035939dc014325da2c66</code>');
      expect(warning).toContain('<b>Produk belum dimapping!</b>');
    });
  });

  describe('/map command parsing', () => {
    it('parses /map to catalog action, and /map help to help action', () => {
      const res1 = parseCommand('/map');
      expect(res1.command).toEqual({ type: 'map', search: 'catalog' });

      const res2 = parseCommand('/map help');
      expect(res2.command).toEqual({ type: 'map', search: 'help' });
    });

    it('parses /map list with and without search keyword', () => {
      const res1 = parseCommand('/map list');
      expect(res1.command).toEqual({ type: 'map', search: 'list', vlProductId: undefined });

      const res2 = parseCommand('/map list gemini pro');
      expect(res2.command).toEqual({ type: 'map', search: 'list', vlProductId: 'gemini pro' });
    });

    it('parses /map with 2 args as interactive mode', () => {
      const res = parseCommand('/map rzk 6a31035939dc014325da2c66');
      expect(res.command).toEqual({
        type: 'map',
        search: 'interactive',
        supplierCode: 'RZK',
        productId: '6a31035939dc014325da2c66',
      });
    });

    it('parses /map with 3+ args as direct mapping with product name or id', () => {
      const res = parseCommand('/map rzk 6a31035939dc014325da2c66 Gemini Pro 1 Bulan');
      expect(res.command).toEqual({
        type: 'map',
        search: 'direct',
        supplierCode: 'RZK',
        productId: '6a31035939dc014325da2c66',
        vlProductId: 'Gemini Pro 1 Bulan',
      });
    });

    it('returns informative guide when only supplier code is provided', () => {
      const res = parseCommand('/map rzk');
      expect(res.command).toBeUndefined();
      expect(res.error).toContain('Penggunaan /map:');
    });
  });

  describe('Product Menu Grid Layout (2-Column Buttons)', () => {
    it('formats 2-column inline keyboard buttons with emojis and prices', async () => {
      const { buildProductGridKeyboard, formatButtonLabel } = await import('../telegram/router');

      const label1 = formatButtonLabel('Google AI Pro Plan - 18 bln PROMO', 350000);
      expect(label1).toContain('🤖');
      expect(label1).toContain('Rp350k');

      const label2 = formatButtonLabel('CANVA EDUCATION - PREMIUM TEACHER', 18900);
      expect(label2).toContain('🎨');
      expect(label2).toContain('Rp18.9k');

      const products = [
        { id: '1', name: 'Google AI Pro', price: 350000 },
        { id: '2', name: 'Canva Education', price: 18900 },
        { id: '3', name: 'Claude API $500', price: 500000 },
      ];

      const keyboard = buildProductGridKeyboard(products, 'map_pick');
      // 3 items -> row 0 has 2 items, row 1 has 1 item
      expect(keyboard.length).toBe(2);
      expect(keyboard[0].length).toBe(2);
      expect(keyboard[0][0].callback_data).toBe('map_pick_0');
      expect(keyboard[0][1].callback_data).toBe('map_pick_1');
      expect(keyboard[1][0].callback_data).toBe('map_pick_2');
    });
  });

  describe('Telegram Mapping Callback Query Handling (map_app and map_rej)', () => {
    it('approves mapping and upserts to productMapping on map_app_ callback', async () => {
      const { handleCallbackQuery } = await import('../telegram/callbacks/confirmBuy');
      const { prisma } = await import('../db');
      const vlClient = await import('../vendinglink/vendingLinkClient');

      // Seed a test product request
      const req = await prisma.productRequest.create({
        data: {
          id: 'test-req-approve-' + Date.now(),
          idempotencyKey: 'idemp-approve-' + Date.now(),
          query: 'test products',
          customerRef: '628123456789',
          status: 'FOUND',
          foundSupplierCode: 'RZK',
          foundProductId: 'loc_test1',
          vlProductId: 'cmvbqvc550001afrx1uz0dafi',
          quotedPrice: 1,
        },
      });

      const editMessageText = vi.fn();
      const answerCbQuery = vi.fn();

      const mockCtx: any = {
        callbackQuery: { data: `map_app_${req.id}` },
        editMessageText,
        answerCbQuery,
        session: {},
      };

      // Mock syncProductMappingToVendingLink
      const syncSpy = vi.spyOn(vlClient, 'syncProductMappingToVendingLink').mockResolvedValue({
        success: true,
      });

      await handleCallbackQuery(mockCtx);

      expect(answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('Mapping berhasil disetujui'));
      expect(editMessageText).toHaveBeenCalledWith(
        expect.stringContaining('Mapping Produk Disetujui!'),
        expect.objectContaining({ parse_mode: 'HTML' })
      );

      // Verify mapping in Prisma
      const mapping = await prisma.productMapping.findUnique({
        where: {
          supplierCode_supplierProductId: {
            supplierCode: 'RZK',
            supplierProductId: 'loc_test1',
          },
        },
      });
      expect(mapping).toBeDefined();
      expect(mapping?.vlProductId).toBe('cmvbqvc550001afrx1uz0dafi');

      syncSpy.mockRestore();
    });

    it('rejects mapping suggestion without modifying mappings on map_rej_ callback', async () => {
      const { handleCallbackQuery } = await import('../telegram/callbacks/confirmBuy');
      const { prisma } = await import('../db');

      const req = await prisma.productRequest.create({
        data: {
          id: 'test-req-reject-' + Date.now(),
          idempotencyKey: 'idemp-reject-' + Date.now(),
          query: 'rejected product query',
          customerRef: '628999999999',
          status: 'FOUND',
          foundSupplierCode: 'RZK',
          foundProductId: 'loc_rejected_sku',
          vlProductId: 'cmvbqvc550001afrx1uz0dafi',
          quotedPrice: 100,
        },
      });

      const editMessageText = vi.fn();
      const answerCbQuery = vi.fn();

      const mockCtx: any = {
        callbackQuery: { data: `map_rej_${req.id}` },
        editMessageText,
        answerCbQuery,
        session: {},
      };

      await handleCallbackQuery(mockCtx);

      expect(answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('Mapping ditolak'));
      expect(editMessageText).toHaveBeenCalledWith(
        expect.stringContaining('Mapping Hermes Ditolak'),
        expect.objectContaining({ parse_mode: 'HTML' })
      );

      // Verify mapping was NOT created
      const mapping = await prisma.productMapping.findUnique({
        where: {
          supplierCode_supplierProductId: {
            supplierCode: 'RZK',
            supplierProductId: 'loc_rejected_sku',
          },
        },
      });
      expect(mapping).toBeNull();
    });

    it('handles already approved mapping gracefully when another admin clicks approve or reject', async () => {
      const { handleCallbackQuery } = await import('../telegram/callbacks/confirmBuy');
      const { prisma } = await import('../db');
      const vlClient = await import('../vendinglink/vendingLinkClient');

      const testSku = 'loc_concurrent_' + Date.now();
      const req = await prisma.productRequest.create({
        data: {
          id: 'test-req-concurrent-' + Date.now(),
          idempotencyKey: 'idemp-concurrent-' + Date.now(),
          query: 'concurrent product test',
          customerRef: '628111222333',
          status: 'FOUND',
          foundSupplierCode: 'RZK',
          foundProductId: testSku,
          vlProductId: 'cmvbqvc550001afrx1uz0dafi',
          quotedPrice: 5000,
        },
      });

      const syncSpy = vi.spyOn(vlClient, 'syncProductMappingToVendingLink').mockResolvedValue({
        success: true,
      });

      // Admin 1 approves
      const ctxAdmin1: any = {
        callbackQuery: { data: `map_app_${req.id}` },
        from: { username: 'Meet_me_a' },
        editMessageText: vi.fn(),
        answerCbQuery: vi.fn(),
        session: {},
      };
      await handleCallbackQuery(ctxAdmin1);
      expect(ctxAdmin1.editMessageText).toHaveBeenCalledWith(
        expect.stringContaining('@Meet_me_a'),
        expect.anything()
      );

      // Admin 2 clicks approve on their message
      const ctxAdmin2: any = {
        callbackQuery: { data: `map_app_${req.id}` },
        from: { username: 'adxpr2' },
        editMessageText: vi.fn(),
        answerCbQuery: vi.fn(),
        session: {},
      };
      await handleCallbackQuery(ctxAdmin2);
      expect(ctxAdmin2.answerCbQuery).toHaveBeenCalledWith(
        expect.stringContaining('Mapping berhasil disetujui (sudah tersimpan sebelumnya)!')
      );

      // Admin 3 tries to click reject on already approved mapping
      const ctxAdmin3: any = {
        callbackQuery: { data: `map_rej_${req.id}` },
        from: { username: 'eeeppp00' },
        editMessageText: vi.fn(),
        answerCbQuery: vi.fn(),
        session: {},
      };
      await handleCallbackQuery(ctxAdmin3);
      expect(ctxAdmin3.answerCbQuery).toHaveBeenCalledWith(
        expect.stringContaining('sudah disetujui sebelumnya')
      );
      expect(ctxAdmin3.editMessageText).toHaveBeenCalledWith(
        expect.stringContaining('Mapping Telah Aktif Sebelumnya'),
        expect.anything()
      );

      syncSpy.mockRestore();
    });
  });
});


