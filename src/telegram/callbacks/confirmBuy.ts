import { MyContext } from '../middleware/session';
import { logger } from '../../lib/logger';
import { createPendingTransaction, resolveVlProductId } from '../../services/orchestrator';
import { prisma } from '../../db';
import { supplierOrderQueue } from '../../queues/queues';
import { buildProductGridKeyboard, escapeHtml } from '../router';
import { fetchVendingLinkProducts } from '../../vendinglink/vendingLinkClient';

export const handleCallbackQuery = async (ctx: MyContext) => {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  const data = ctx.callbackQuery.data;

  try {
    if (data === 'buy_cancel') {
      await ctx.editMessageText('❌ Purchase cancelled.');
      return;
    }

    if (data === 'map_cancel') {
      ctx.session.pendingMap = undefined;
      await ctx.editMessageText('❌ Menu ditutup.');
      return;
    }

    if (data === 'map_help') {
      await ctx.editMessageText(
        '🗺️ <b>Panduan Pemetaan Produk (/map)</b>\n\n' +
        '1️⃣ <b>Katalog Menu Interaktif:</b>\n' +
        'Ketik <code>/map</code> untuk membuka menu tombol katalog 2-kolom seluruh produk aktif.\n\n' +
        '2️⃣ <b>Pilih Interaktif untuk Supplier:</b>\n' +
        'Ketik <code>/map &lt;SUPPLIER&gt; &lt;PRODUCT_ID&gt;</code> untuk memilih dengan tombol!\n\n' +
        '3️⃣ <b>Cari Produk:</b>\n' +
        'Ketik <code>/map list &lt;kata kunci&gt;</code> untuk memfilter produk.',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Kembali ke Menu', callback_data: 'map_catalog_back' }],
              [{ text: '❌ Tutup', callback_data: 'map_cancel' }],
            ],
          },
        }
      );
      return;
    }

    if (data === 'map_catalog_back' || data === 'map_refresh') {
      const res = await fetchVendingLinkProducts(undefined, 10);
      if (!res.success || res.products.length === 0) {
        await ctx.editMessageText(
          '⚠️ Gagal menyegarkan katalog VendingLink. Silakan coba kembali dengan perintah /map.'
        );
        return;
      }

      ctx.session.pendingMap = {
        options: res.products.map(p => ({
          vlProductId: p.id,
          name: p.name,
          price: p.price,
        })),
      };

      const keyboard = buildProductGridKeyboard(
        res.products,
        'map_pick',
        [
          [
            { text: '🔄 Segarkan', callback_data: 'map_refresh' },
            { text: 'ℹ️ Panduan', callback_data: 'map_help' },
          ],
          [{ text: '❌ Tutup', callback_data: 'map_cancel' }],
        ]
      );

      await ctx.editMessageText(
        '🛍️ <b>Katalog Produk VendingLink</b>\n' +
        '<i>Pilih salah satu produk di bawah untuk detail & status pemetaan:</i>',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: keyboard,
          },
        }
      );
      return;
    }

    if (data.startsWith('map_pick_')) {
      const index = parseInt(data.replace('map_pick_', ''), 10);
      const session = ctx.session.pendingMap;

      if (!session || isNaN(index) || !session.options[index]) {
        await ctx.editMessageText('❌ Sesi menu telah kedaluwarsa. Silakan ketik /map kembali.');
        return;
      }

      const selected = session.options[index];

      // A. JIKA DALAM MODE MAPPING SUPPLIER -> VENDINGLINK (/map <SUPPLIER> <PRODUCT_ID>)
      if (session.supplierCode && session.supplierProductId) {
        const { supplierCode, supplierProductId, supplierProductName } = session;

        const existing = await prisma.productMapping.findUnique({
          where: {
            supplierCode_supplierProductId: { supplierCode, supplierProductId },
          },
        });

        await prisma.productMapping.upsert({
          where: {
            supplierCode_supplierProductId: { supplierCode, supplierProductId },
          },
          update: {
            vlProductId: selected.vlProductId,
            displayName: selected.name,
          },
          create: {
            supplierCode,
            supplierProductId,
            vlProductId: selected.vlProductId,
            displayName: selected.name,
          },
        });

        ctx.session.pendingMap = undefined;

        const action = existing ? 'diperbarui' : 'dibuat';
        await ctx.editMessageText(
          `✅ <b>Mapping Produk Berhasil ${action}!</b>\n\n` +
          `• <b>Supplier:</b> <code>${escapeHtml(supplierCode)}</code>\n` +
          `• <b>Produk Supplier:</b> <code>${escapeHtml(supplierProductId)}</code>${supplierProductName ? ` (${escapeHtml(supplierProductName)})` : ''}\n` +
          `• <b>Produk VendingLink:</b> <b>${escapeHtml(selected.name)}</b> (<code>${escapeHtml(selected.vlProductId)}</code>)\n\n` +
          `🚀 Sekarang Anda bisa langsung membeli produk ini dengan:\n` +
          `<code>/buy ${escapeHtml(supplierCode)} ${escapeHtml(supplierProductId)}</code>`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // B. JIKA DALAM MODE BROWSE KATALOG (/map biasa)
      const existingMappings = await prisma.productMapping.findMany({
        where: { vlProductId: selected.vlProductId },
      });

      let detailMsg = `🛍️ <b>Detail Produk VendingLink</b>\n\n`;
      detailMsg += `• <b>Nama:</b> <b>${escapeHtml(selected.name)}</b>\n`;
      detailMsg += `• <b>Harga:</b> Rp${selected.price.toLocaleString('id-ID')}\n`;
      detailMsg += `• <b>ID VendingLink:</b> <code>${escapeHtml(selected.vlProductId)}</code>\n\n`;

      if (existingMappings.length > 0) {
        detailMsg += `🔗 <b>Supplier Terpetakan (${existingMappings.length}):</b>\n`;
        for (const m of existingMappings) {
          detailMsg += `  • <code>${escapeHtml(m.supplierCode)}</code>: <code>${escapeHtml(m.supplierProductId)}</code>\n`;
        }
      } else {
        detailMsg += `ℹ️ <i>Belum ada produk supplier yang dipetakan ke produk ini.</i>\n`;
      }

      detailMsg += `\n💡 <b>Cara Mapping ke Produk Ini:</b>\n`;
      detailMsg += `Ketik: <code>/map &lt;SUPPLIER&gt; &lt;PRODUCT_ID&gt; ${escapeHtml(selected.vlProductId)}</code>`;

      await ctx.editMessageText(detailMsg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔙 Kembali ke Menu', callback_data: 'map_catalog_back' },
              { text: '❌ Tutup', callback_data: 'map_cancel' },
            ],
          ],
        },
      });
      return;
    }

    if (data.startsWith('buy_confirm_')) {
      const parts = data.split('_');
      // buy_confirm_SUPPLIER_PRODUCTID_QTY
      // PRODUCTID may itself contain underscores (e.g. "loc_test1"),
      // so supplier = first segment after prefix, qty = last segment, productId = everything in between.
      const supplier = parts[2];
      const qty = parseInt(parts[parts.length - 1], 10);
      const productId = parts.slice(3, -1).join('_');

      if (!supplier || !productId || isNaN(qty) || qty < 1) {
        await ctx.editMessageText('❌ Invalid confirmation data. Please run /buy again.');
        return;
      }

      // Extract emails if they were saved in session
      let emails: string[] | undefined;
      if (ctx.session.pendingBuy && ctx.session.pendingBuy.productId === productId && ctx.session.pendingBuy.qty === qty) {
        emails = ctx.session.pendingBuy.emails;
      }
      
      // Wipe session
      ctx.session.state = undefined;
      ctx.session.pendingBuy = undefined;
      
      await ctx.editMessageText(`⏳ Enqueueing purchase of ${qty}x ${productId} from ${supplier}...`);
      
      try {
        // BR-5e hard block: refuse to spend money on an unmapped product.
        // resolveVlProductId already has this data, so we check before enqueueing.
        const vlProductId = await resolveVlProductId(supplier, productId);
        if (!vlProductId) {
          await ctx.reply(
            `❌ <b>Produk belum dimapping ke VendingLink</b>.\n` +
            `Jalankan dulu: <code>/map ${escapeHtml(supplier)} ${escapeHtml(productId)} &lt;VL_PRODUCT_ID&gt;</code>\n` +
            `Pembelian tidak dilanjutkan.`,
            { parse_mode: 'HTML' }
          );
          return;
        }

        const tx = await createPendingTransaction(
          supplier, 
          productId, 
          qty, 
          emails,
          ctx.from!.id.toString()
        );
        
        await supplierOrderQueue.add('order', { txId: tx.id }, { jobId: tx.transactionId });
        await ctx.reply(`✅ Transaction created (TX: ${tx.transactionId}). Enqueueing...`);
      } catch (err: any) {
        await ctx.reply(`❌ Failed to create transaction: ${err.message}`);
      }
      
      return;
    }

    await ctx.answerCbQuery('Unknown action.');
  } catch (err) {
    logger.error({ err }, 'Error handling callback query');
    await ctx.answerCbQuery('An error occurred.');
  }
};
