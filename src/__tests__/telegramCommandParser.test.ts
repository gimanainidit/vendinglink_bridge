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
      const warning = `⚠️ <b>Produk belum dimapping!</b> Jalankan dulu:\n<code>/map ${escapeHtml(supplierCode)} ${escapeHtml(productId)} &lt;VL_PRODUCT_ID&gt;</code>\nJika dilanjutkan, transaksi akan parkir di <code>NEEDS_REVIEW</code> sampai dimapping &amp; di-retry.`;

      expect(warning).toContain('<code>NEEDS_REVIEW</code>');
      expect(warning).toContain('&lt;VL_PRODUCT_ID&gt;');
      expect(warning).not.toContain('<VL_PRODUCT_ID>');
    });
  });
});
