import { randomBytes } from 'crypto';
import { Product } from '../suppliers/types';
import { escapeHtml, formatMoney } from './format';
import { PendingList } from './middleware/session';

export const LIST_PAGE_SIZE = 10;
export const LIST_TTL_MS = 15 * 60 * 1000;

const BUTTONS_PER_ROW = 5;
const QTY_PRESETS = [1, 2, 3, 5];

type Button = { text: string; callback_data: string };

export const createToken = (): string => randomBytes(4).toString('hex');

export const createList = (
  supplierCode: string,
  supplierName: string,
  products: Product[],
  search?: string
): PendingList => ({
  listId: createToken(),
  supplierCode,
  supplierName,
  search,
  createdAt: Date.now(),
  items: products.map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    currency: p.currency,
    inStock: p.availability === 'in_stock',
    requiresEmail: p.requiresEmail,
  })),
});

export const isListActive = (list: PendingList | undefined, now = Date.now()): list is PendingList =>
  Boolean(list) && now - list!.createdAt < LIST_TTL_MS;

const pageCount = (list: PendingList): number =>
  Math.max(1, Math.ceil(list.items.length / LIST_PAGE_SIZE));

const formatItemPrice = (item: PendingList['items'][number]): string =>
  item.price === undefined || item.price === null ? 'harga ?' : formatMoney(item.price, item.currency);

export const renderListPage = (
  list: PendingList,
  requestedPage: number
): { text: string; keyboard: Button[][] } => {
  const pages = pageCount(list);
  const page = Math.min(Math.max(requestedPage, 0), pages - 1);
  const start = page * LIST_PAGE_SIZE;
  const visible = list.items.slice(start, start + LIST_PAGE_SIZE);

  const searchLabel = list.search ? ` — hasil "${escapeHtml(list.search)}"` : '';
  let text = `📦 <b>${escapeHtml(list.supplierName)}</b>${searchLabel} (hal ${page + 1}/${pages})\n\n`;

  visible.forEach((item, offset) => {
    const status = item.inStock ? '✅' : '❌';
    const emailBadge = item.requiresEmail ? ' 📧' : '';
    text += `${start + offset + 1}. ${status} ${escapeHtml(item.name)}${emailBadge} — ${formatItemPrice(item)}\n`;
  });

  text += `\n<i>Tap nomor, atau ketik: <code>${start + 1}</code> atau <code>${start + 1} x2</code> (qty 2)</i>`;

  const keyboard: Button[][] = [];
  for (let i = 0; i < visible.length; i += BUTTONS_PER_ROW) {
    keyboard.push(
      visible.slice(i, i + BUTTONS_PER_ROW).map((_, offset) => {
        const index = start + i + offset;
        return { text: `${index + 1}`, callback_data: `list_pick_${list.listId}_${index}` };
      })
    );
  }

  const nav: Button[] = [];
  if (page > 0) nav.push({ text: '◀️', callback_data: `list_page_${list.listId}_${page - 1}` });
  if (page < pages - 1) nav.push({ text: '▶️', callback_data: `list_page_${list.listId}_${page + 1}` });
  nav.push({ text: '❌ Tutup', callback_data: `list_close_${list.listId}` });
  keyboard.push(nav);

  return { text, keyboard };
};

export const renderProductCard = (
  list: PendingList,
  index: number,
  isMapped: boolean,
  maxQty: number
): { text: string; keyboard: Button[][] } => {
  const item = list.items[index];

  let text = `🛒 <b>${escapeHtml(item.name)}</b>\n\n`;
  text += `Supplier: ${escapeHtml(list.supplierName)} (<code>${escapeHtml(list.supplierCode)}</code>)\n`;
  text += `ID: <code>${escapeHtml(item.id)}</code>\n`;
  text += `Harga: ${formatItemPrice(item)}\n`;
  text += `Mapping: ${isMapped ? '✅ Sudah dimapping' : '⚠️ Belum dimapping'}\n`;
  if (item.requiresEmail) text += `📧 Butuh email aktivasi\n`;
  text += `\n<i>Pilih qty, atau ketik jumlahnya (maks ${maxQty}).</i>`;

  const qtyRow = QTY_PRESETS.filter((qty) => qty <= maxQty).map((qty) => ({
    text: `Qty ${qty}`,
    callback_data: `list_qty_${list.listId}_${index}_${qty}`,
  }));

  return {
    text,
    keyboard: [qtyRow, [{ text: '🔙 Kembali', callback_data: `list_back_${list.listId}_${index}` }]],
  };
};

export const pageOfIndex = (index: number): number => Math.floor(index / LIST_PAGE_SIZE);

/** Parses "3", "3 2", "3x2" and "3 x2" into a zero-based list index and an optional quantity. */
export const parseListInput = (text: string): { index: number; qty?: number } | null => {
  const match = text.trim().match(/^(\d{1,4})(?:\s*x\s*(\d{1,4})|\s+(\d{1,4}))?$/i);
  if (!match) return null;
  const qty = match[2] ?? match[3];
  return {
    index: parseInt(match[1], 10) - 1,
    qty: qty === undefined ? undefined : parseInt(qty, 10),
  };
};
