import { MyContext } from '../middleware/session';
import { logger } from '../../lib/logger';
import { createPendingTransaction } from '../../services/orchestrator';

export const handleCallbackQuery = async (ctx: MyContext) => {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  const data = ctx.callbackQuery.data;

  try {
    if (data === 'buy_cancel') {
      await ctx.editMessageText('❌ Purchase cancelled.');
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
        const tx = await createPendingTransaction(
          supplier, 
          productId, 
          qty, 
          emails,
          ctx.from!.id.toString()
        );
        
        // In Phase 3: await queues.supplierOrder.add(tx.transactionId, { txId: tx.id })
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
