import { env } from '../../config/env';
import { retryMappingSync } from '../../services/mappingService';
import { pageOfIndex, isListActive, renderListPage } from '../listView';
import { MyContext } from '../middleware/session';
import { buyPreCheck, mapController, showProductCard } from '../router';

const expiredMessage = 'Daftar sudah kedaluwarsa. Jalankan /list lagi.';

const showPage = async (ctx: MyContext, page: number) => {
  const { text, keyboard } = renderListPage(ctx.session.pendingList!, page);
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
};

/** Handles list_<action>_<listId>[_args] buttons. Returns false if the data is not a list action. */
export const handleListCallback = async (ctx: MyContext, data: string): Promise<boolean> => {
  if (!data.startsWith('list_')) return false;

  const [, action, listId, ...args] = data.split('_');
  const list = ctx.session.pendingList;

  // Buttons address items by index, so a button from an older list must never resolve
  // against the current one: it would select a different product.
  if (!isListActive(list) || list.listId !== listId) {
    await ctx.answerCbQuery(expiredMessage, { show_alert: true });
    return true;
  }

  switch (action) {
    case 'page': {
      await ctx.answerCbQuery();
      ctx.session.state = undefined;
      await showPage(ctx, parseInt(args[0], 10));
      return true;
    }
    case 'back': {
      await ctx.answerCbQuery();
      ctx.session.state = undefined;
      await showPage(ctx, pageOfIndex(parseInt(args[0], 10)));
      return true;
    }
    case 'pick': {
      const index = parseInt(args[0], 10);
      const item = list.items[index];
      if (!item) {
        await ctx.answerCbQuery(expiredMessage, { show_alert: true });
        return true;
      }
      if (!item.inStock) {
        await ctx.answerCbQuery(`${item.name} sedang habis.`, { show_alert: true });
        return true;
      }
      await ctx.answerCbQuery();
      await showProductCard(ctx, index, 'edit');
      return true;
    }
    case 'qty': {
      const index = parseInt(args[0], 10);
      const qty = parseInt(args[1], 10);
      const item = list.items[index];
      if (!item || isNaN(qty) || qty < 1 || qty > env.MAX_BUY_QTY) {
        await ctx.answerCbQuery(expiredMessage, { show_alert: true });
        return true;
      }
      await ctx.answerCbQuery();
      await ctx.editMessageReplyMarkup(undefined);
      await buyPreCheck(ctx, list.supplierCode, item.id, qty);
      return true;
    }
    case 'close': {
      await ctx.answerCbQuery();
      ctx.session.pendingList = undefined;
      ctx.session.state = undefined;
      await ctx.editMessageText('❌ Daftar ditutup.');
      return true;
    }
    default:
      return false;
  }
};

/** Handles the buttons shown when the mapping gate stops a purchase. */
export const handleGateCallback = async (ctx: MyContext, data: string): Promise<boolean> => {
  if (!data.startsWith('gate_')) return false;

  const purchase = ctx.session.resumeBuy;
  if (!purchase) {
    await ctx.answerCbQuery('Sesi pembelian sudah berakhir. Mulai lagi dari /list atau /buy.', { show_alert: true });
    return true;
  }
  const { supplierCode, productId, qty, emails } = purchase;

  if (data === 'gate_map') {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined);
    await mapController(ctx, { type: 'map', search: 'interactive', supplierCode, productId });
    return true;
  }

  if (data === 'gate_sync') {
    const sync = await retryMappingSync(supplierCode, productId);
    if (!sync.synced) {
      await ctx.answerCbQuery(`Sync gagal: ${sync.syncError || 'unknown'}`.slice(0, 200), { show_alert: true });
      return true;
    }
    await ctx.answerCbQuery('Sync berhasil.');
  } else {
    await ctx.answerCbQuery();
  }

  await ctx.editMessageReplyMarkup(undefined);
  await buyPreCheck(ctx, supplierCode, productId, qty, emails);
  return true;
};
