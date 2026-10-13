import { MyContext } from '../middleware/session';
import { logger } from '../../lib/logger';
import { createPendingTransaction, resolveVlProductId } from '../../services/orchestrator';
import { prisma } from '../../db';
import { supplierOrderQueue } from '../../queues/queues';
import { escapeHtml } from '../router';

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
      await ctx.editMessageText('❌ Pemetaan produk dibatalkan.');
      return;
    }

    if (data.startsWith('map_pick_')) {
      const index = parseInt(data.replace('map_pick_', ''), 10);
      const session = ctx.session.pendingMap;

      if (!session || isNaN(index) || !session.options[index]) {
        await ctx.editMessageText('❌ Sesi pemilihan mapping telah kedaluwarsa. Silakan jalankan perintah /map kembali.');
        return;
      }

      const selected = session.options[index];
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
