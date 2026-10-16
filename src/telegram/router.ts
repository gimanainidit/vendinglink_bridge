import { parseCommand, ParsedCommand } from './parser/commandParser';
import { MyContext } from './middleware/session';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { supplierFactory } from '../suppliers/SupplierFactory';
import { env } from '../config/env';
import { prisma } from '../db';
import { agentGuardrailService } from '../services/agentGuardrailService';
import { fetchVendingLinkProducts } from '../vendinglink/vendingLinkClient';

export const escapeHtml = (str: string): string =>
  str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Stubs for controllers (to be implemented in Phase 2)
const listController = async (ctx: MyContext, supplierCode: string, search?: string) => {
  try {
    const adapter = supplierFactory.getAdapter(supplierCode);
    await ctx.reply(`⏳ Fetching products from ${adapter.displayName}...`);
    const products = await adapter.getProductList(search);
    
    if (products.length === 0) {
      await ctx.reply(`No products found${search ? ' matching ' + search : ''}.`);
      return;
    }

    let msg = `📦 <b>${escapeHtml(adapter.displayName)} Products:</b>\n\n`;
    for (const p of products.slice(0, 15)) {
      const status = p.availability === 'in_stock' ? '✅' : '❌';
      const emailBadge = p.requiresEmail ? ' 📧' : '';
      const safeName = escapeHtml(p.name);
      const formattedPrice = p.currency === 'USD' ? `$${p.price?.toFixed(2)} USD` : `Rp${p.price?.toLocaleString('id-ID') || '?'}`;
      msg += `${status} <code>${escapeHtml(p.id)}</code> - ${safeName}${emailBadge} - ${formattedPrice}\n`;
    }
    
    if (products.length > 15) {
      msg += `\n<i>...and ${products.length - 15} more. Gunakan: /list ${escapeHtml(adapter.code)} &lt;keyword&gt; untuk filter.</i>`;
    }
    
    await ctx.reply(msg, { parse_mode: 'HTML' });
  } catch (err: any) {
    await ctx.reply(`❌ ${err.message}`);
  }
};

const buyPreCheck = async (ctx: MyContext, supplierCode: string, productId: string, qty: number, emails?: string[]) => {
  try {
    const adapter = supplierFactory.getAdapter(supplierCode);
    const product = await adapter.getProduct(productId);

    if (!product) {
      await ctx.reply(`❌ Product ${productId} not found at ${adapter.displayName}.`);
      return;
    }

    if (product.availability !== 'in_stock') {
      await ctx.reply(`❌ Product ${product.name} is currently out of stock.`);
      return;
    }

    if (product.requiresEmail && (!emails || emails.length !== qty)) {
      ctx.session.state = 'AWAITING_EMAIL';
      ctx.session.pendingBuy = { supplierCode, productId, qty };
      await ctx.reply(`This product requires ${qty} email(s) for activation. Please type the emails separated by commas:`);
      return;
    }

    const price = product.price || 0;
    const total = price * qty;

    // Check balance
    const balance = await adapter.getBalance();

    // --- BR-5e: early mapping warning ---
    // Show advisory BEFORE the Confirm button so admin can /map first.
    // Hard block runs again at enqueue time in confirmBuy.ts.
    const mapping = await prisma.productMapping.findUnique({
      where: {
        supplierCode_supplierProductId: { supplierCode: adapter.code, supplierProductId: productId },
      },
    });

    const safeSupplierCode = escapeHtml(adapter.code);
    const safeProductId = escapeHtml(productId);
    const safeSupplierName = escapeHtml(adapter.displayName);
    const safeProductName = escapeHtml(product.name);

    const mappingWarning = mapping
      ? ''
      : `\n⚠️ <b>Produk belum dimapping!</b> Jalankan:\n<code>/map ${safeSupplierCode} ${safeProductId}</code>\n<i>(Pilih produk VendingLink yang cocok dari tombol)</i>\n`;

    const totalFormatted = adapter.code === 'PDA' ? `$${total.toFixed(2)} USD` : `Rp${total.toLocaleString('id-ID')}`;
    const balanceBeforeFormatted = adapter.code === 'PDA' ? `$${balance.toFixed(2)} USD` : `Rp${balance.toLocaleString('id-ID')}`;
    const balanceAfterFormatted = adapter.code === 'PDA' ? `$${(balance - total).toFixed(2)} USD` : `Rp${(balance - total).toLocaleString('id-ID')}`;

    let msg = `🛒 <b>Confirm Purchase</b>\n\n`;
    msg += `Supplier: ${safeSupplierName} (<code>${safeSupplierCode}</code>)\n`;
    msg += `Product: ${safeProductName}\n`;
    msg += `Qty: ${qty}\n`;
    if (emails && emails.length > 0) {
      msg += `Emails: ${emails.map(e => escapeHtml(e)).join(', ')}\n`;
    }
    msg += `Total: ${totalFormatted}\n`;
    msg += `Balance: ${balanceBeforeFormatted} → ${balanceAfterFormatted}\n`;
    msg += mappingWarning;

    if (balance < total) {
      await ctx.reply(`❌ Insufficient balance!\n\n${msg}`, { parse_mode: 'HTML' });
      return;
    }

    await ctx.reply(msg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Confirm', callback_data: `buy_confirm_${supplierCode}_${productId}_${qty}` },
            { text: '❌ Cancel', callback_data: 'buy_cancel' }
          ]
        ]
      }
    });
  } catch (err: any) {
    await ctx.reply(`❌ ${err.message}`);
  }
};

export const getProductEmoji = (name: string): string => {
  const lower = name.toLowerCase();
  if (lower.includes('google') || lower.includes('gemini')) return '🤖';
  if (lower.includes('claude') || lower.includes('anthropic')) return '✴️';
  if (lower.includes('chatgpt') || lower.includes('openai') || lower.includes('gpt')) return '🟢';
  if (lower.includes('canva')) return '🎨';
  if (lower.includes('antivirus') || lower.includes('bitdefender') || lower.includes('mcafee')) return '🛡️';
  if (lower.includes('duolingo')) return '🦉';
  if (lower.includes('spotify')) return '🎵';
  if (lower.includes('youtube')) return '▶️';
  if (lower.includes('netflix') || lower.includes('hbo')) return '📺';
  if (lower.includes('apple')) return '🍎';
  if (lower.includes('adobe') || lower.includes('figma')) return '🎨';
  if (lower.includes('capcut')) return '✂️';
  if (lower.includes('mail') || lower.includes('gmail')) return '✉️';
  if (lower.includes('notion')) return '📓';
  if (lower.includes('prime')) return '📦';
  if (lower.includes('telegram')) return '✈️';
  return '📦';
};

export const formatPriceShort = (price: number): string => {
  if (price >= 1000000) {
    const jt = price / 1000000;
    return `Rp${jt % 1 === 0 ? jt : jt.toFixed(1)}jt`;
  }
  if (price >= 1000) {
    const rb = price / 1000;
    return `Rp${rb % 1 === 0 ? rb : rb.toFixed(1)}k`;
  }
  return `Rp${price}`;
};

export const formatButtonLabel = (name: string, price: number): string => {
  const emoji = getProductEmoji(name);
  const priceStr = formatPriceShort(price);

  let cleanName = name
    .replace(/PROMO|HANYA HARI INI|PREMIUM|FULL AKSES|Lisensi|Subscription/gi, '')
    .replace(/[-–]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleanName.length > 13) {
    cleanName = cleanName.slice(0, 12).trim() + '…';
  }

  return `${emoji} ${cleanName.toUpperCase()} ${priceStr}`;
};

export const buildProductGridKeyboard = (
  products: Array<{ id: string; name: string; price: number }>,
  actionPrefix: string,
  extraButtons: Array<Array<{ text: string; callback_data: string }>> = []
) => {
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];

  for (let i = 0; i < products.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = [];
    const p1 = products[i];
    row.push({
      text: formatButtonLabel(p1.name, p1.price),
      callback_data: `${actionPrefix}_${i}`,
    });

    if (i + 1 < products.length) {
      const p2 = products[i + 1];
      row.push({
        text: formatButtonLabel(p2.name, p2.price),
        callback_data: `${actionPrefix}_${i + 1}`,
      });
    }
    keyboard.push(row);
  }

  for (const extraRow of extraButtons) {
    keyboard.push(extraRow);
  }

  return keyboard;
};

export const mapController = async (ctx: MyContext, command: ParsedCommand) => {
  const subAction = command.search; // 'catalog' | 'help' | 'list' | 'interactive' | 'direct'

  // 1. HELP GUIDE
  if (subAction === 'help') {
    await ctx.reply(
      '🗺️ <b>Panduan Pemetaan Produk (/map)</b>\n\n' +
      'Perintah ini menghubungkan produk di supplier dengan produk di katalog VendingLink:\n\n' +
      '1️⃣ <b>Katalog Menu Interaktif (Seperti Gambar):</b>\n' +
      '<code>/map</code>\n' +
      '👉 Langsung membuka menu tombol katalog 2-kolom seluruh produk aktif VendingLink!\n\n' +
      '2️⃣ <b>Cari Produk Tertentu:</b>\n' +
      '<code>/map list [kata kunci]</code>\n' +
      '<i>Contoh: <code>/map list gemini</code> atau <code>/map list claude</code></i>\n\n' +
      '3️⃣ <b>Pilih Interaktif untuk Supplier (Rekomendasi):</b>\n' +
      '<code>/map &lt;SUPPLIER&gt; &lt;PRODUCT_ID&gt;</code>\n' +
      '<i>Contoh: <code>/map RZK 6a31035939dc014325da2c66</code></i>\n' +
      '👉 Bot otomatis mencarikan produk yang cocok dan menampilkan menu tombol pilihan!\n\n' +
      '4️⃣ <b>Map Langsung dengan Nama atau ID:</b>\n' +
      '<code>/map &lt;SUPPLIER&gt; &lt;PRODUCT_ID&gt; &lt;Nama atau ID&gt;</code>\n' +
      '<i>Contoh: <code>/map RZK 6a31035939dc014325da2c66 Gemini</code></i>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  // 2. CATALOG MENU (User runs /map) OR LIST (User runs /map list [keyword])
  if (subAction === 'catalog' || subAction === 'list') {
    const keyword = command.vlProductId;
    const res = await fetchVendingLinkProducts(keyword, 10);

    if (!res.success) {
      await ctx.reply(
        `⚠️ <b>Koneksi ke VendingLink Mengalami Kendala</b>\n\n` +
        `• <b>URL:</b> <code>${escapeHtml(res.url)}</code>\n` +
        `• <b>Status:</b> <code>${res.statusCode || 'Offline / Timeout'}</code>\n` +
        `• <b>Keterangan:</b> <code>${escapeHtml(res.error || 'Network connection failed')}</code>\n\n` +
        `💡 <i>Pastikan VENDINGLINK_URL diatur ke https://toko.txsiber.online dan Storefront telah selesai deploy di Vercel.</i>\n\n` +
        `Anda tetap dapat memetakan langsung secara manual:\n` +
        `<code>/map &lt;SUPPLIER&gt; &lt;PRODUCT_ID&gt; &lt;VL_PRODUCT_ID&gt;</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (res.products.length === 0) {
      await ctx.reply(
        `ℹ️ Tidak ada produk aktif ditemukan di VendingLink${keyword ? ' dengan kata kunci "' + escapeHtml(keyword) + '"' : ''}.\n` +
        `<i>Pastikan produk sudah ditambahkan dan bertatus aktif di Storefront Admin.</i>`,
        { parse_mode: 'HTML' }
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

    let msg = `🛍️ <b>Katalog Produk VendingLink</b>\n`;
    if (keyword) {
      msg += `<i>Hasil pencarian untuk "${escapeHtml(keyword)}":</i>\n\n`;
    } else {
      msg += `<i>Pilih salah satu produk di bawah untuk detail & status pemetaan:</i>\n\n`;
    }

    await ctx.reply(msg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: keyboard,
      },
    });
    return;
  }

  // 3. INTERACTIVE MAPPING (User provides supplier and product ID: /map <SUPPLIER> <PRODUCT_ID>)
  if (subAction === 'interactive') {
    const supplierCode = command.supplierCode!;
    const productId = command.productId!;

    let supplierProductName = '';
    let supplierDisplayName = supplierCode;
    try {
      const adapter = supplierFactory.getAdapter(supplierCode);
      supplierDisplayName = adapter.displayName;
      const supplierProduct = await adapter.getProduct(productId);
      if (supplierProduct) {
        supplierProductName = supplierProduct.name;
      }
    } catch {}

    // Search VendingLink for matching products
    let candidates: Array<{ id: string; name: string; price: number }> = [];

    if (supplierProductName) {
      const words = supplierProductName.replace(/[^a-zA-Z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
      for (const w of words.slice(0, 2)) {
        const fetchRes = await fetchVendingLinkProducts(w, 8);
        if (fetchRes.success) {
          for (const m of fetchRes.products) {
            if (!candidates.some(c => c.id === m.id)) {
              candidates.push(m);
            }
          }
        }
      }
    }

    // Append general active products up to 8
    if (candidates.length < 8) {
      const allRes = await fetchVendingLinkProducts(undefined, 10);
      if (allRes.success) {
        for (const m of allRes.products) {
          if (!candidates.some(c => c.id === m.id)) {
            candidates.push(m);
          }
        }
      }
    }

    if (candidates.length === 0) {
      await ctx.reply(
        `⚠️ <b>Tidak dapat mengambil produk dari VendingLink</b>\n\n` +
        `Koneksi ke Storefront mengalami kendala atau katalog produk masih kosong.\n\n` +
        `Anda tetap dapat memetakan langsung secara manual menggunakan ID produk:\n` +
        `<code>/map ${escapeHtml(supplierCode)} ${escapeHtml(productId)} &lt;VL_PRODUCT_ID&gt;</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const topOptions = candidates.slice(0, 8);
    ctx.session.pendingMap = {
      supplierCode,
      supplierProductId: productId,
      supplierProductName: supplierProductName || undefined,
      options: topOptions.map(c => ({
        vlProductId: c.id,
        name: c.name,
        price: c.price,
      })),
    };

    const keyboard = buildProductGridKeyboard(
      topOptions,
      'map_pick',
      [[{ text: '❌ Batal', callback_data: 'map_cancel' }]]
    );

    let msg = `🗺️ <b>Pilih Produk VendingLink untuk Dimapping:</b>\n\n`;
    msg += `📦 <b>Supplier:</b> <code>${escapeHtml(supplierCode)}</code> (${escapeHtml(supplierDisplayName)})\n`;
    msg += `🏷️ <b>Produk Supplier:</b> <b>${escapeHtml(supplierProductName || productId)}</b> (<code>${escapeHtml(productId)}</code>)\n\n`;
    msg += `Silakan pilih produk VendingLink yang cocok dari menu tombol di bawah:`;

    await ctx.reply(msg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: keyboard,
      },
    });
    return;
  }

  // 4. DIRECT (User provided target name or ID: /map <SUPPLIER> <PRODUCT_ID> <TARGET>)
  if (subAction === 'direct') {
    const supplierCode = command.supplierCode!;
    const supplierProductId = command.productId!;
    const target = command.vlProductId!;

    // Check if target matches product name in VendingLink
    const searchRes = await fetchVendingLinkProducts(target, 6);
    const searchMatches = searchRes.products;

    // If exactly 1 match by name
    if (searchMatches.length === 1) {
      const match = searchMatches[0];
      const existing = await prisma.productMapping.findUnique({
        where: {
          supplierCode_supplierProductId: { supplierCode, supplierProductId },
        },
      });

      await prisma.productMapping.upsert({
        where: {
          supplierCode_supplierProductId: { supplierCode, supplierProductId },
        },
        update: { vlProductId: match.id, displayName: match.name },
        create: { supplierCode, supplierProductId, vlProductId: match.id, displayName: match.name },
      });

      const action = existing ? 'diperbarui' : 'dibuat';
      await ctx.reply(
        `✅ <b>Mapping ${action} (berdasarkan nama)!</b>\n\n` +
        `• <b>Supplier:</b> <code>${escapeHtml(supplierCode)}</code>\n` +
        `• <b>Produk Supplier:</b> <code>${escapeHtml(supplierProductId)}</code>\n` +
        `• <b>Produk VendingLink:</b> <b>${escapeHtml(match.name)}</b> (<code>${escapeHtml(match.id)}</code>)\n\n` +
        `🚀 Beli sekarang:\n<code>/buy ${escapeHtml(supplierCode)} ${escapeHtml(supplierProductId)}</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // If multiple matches by name, present interactive buttons grid
    if (searchMatches.length > 1) {
      ctx.session.pendingMap = {
        supplierCode,
        supplierProductId,
        options: searchMatches.map(c => ({
          vlProductId: c.id,
          name: c.name,
          price: c.price,
        })),
      };

      const keyboard = buildProductGridKeyboard(
        searchMatches,
        'map_pick',
        [[{ text: '❌ Batal', callback_data: 'map_cancel' }]]
      );

      await ctx.reply(
        `🔍 Ditemukan ${searchMatches.length} produk VendingLink yang cocok dengan "<i>${escapeHtml(target)}</i>".\nSilakan pilih salah satu di bawah:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: keyboard,
          },
        }
      );
      return;
    }

    // If no match found by name, treat target as raw vlProductId (exact ID)
    const existing = await prisma.productMapping.findUnique({
      where: {
        supplierCode_supplierProductId: { supplierCode, supplierProductId },
      },
    });

    await prisma.productMapping.upsert({
      where: {
        supplierCode_supplierProductId: { supplierCode, supplierProductId },
      },
      update: { vlProductId: target },
      create: { supplierCode, supplierProductId, vlProductId: target },
    });

    const action = existing ? 'diperbarui' : 'dibuat';
    await ctx.reply(
      `✅ <b>Mapping ${action}!</b>\n\n` +
      `• <b>Supplier:</b> <code>${escapeHtml(supplierCode)}</code>\n` +
      `• <b>Produk Supplier:</b> <code>${escapeHtml(supplierProductId)}</code>\n` +
      `• <b>VendingLink Product ID:</b> <code>${escapeHtml(target)}</code>\n\n` +
      `🚀 Beli sekarang:\n<code>/buy ${escapeHtml(supplierCode)} ${escapeHtml(supplierProductId)}</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }
};

export const handleTextMessage = async (ctx: MyContext) => {
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  if (!text) return;

  // Handle conversational state first
  if (ctx.session.state === 'AWAITING_EMAIL' && ctx.session.pendingBuy && !text.startsWith('/')) {
    const emails = text.split(',').map(e => e.trim());
    const emailSchema = z.string().email();
    let valid = true;
    for (const e of emails) {
      if (!emailSchema.safeParse(e).success) valid = false;
    }

    if (!valid || emails.length !== ctx.session.pendingBuy.qty) {
      await ctx.reply(`Invalid emails or count mismatch. Need exactly ${ctx.session.pendingBuy.qty} email(s). Please try again, or type /cancel.`);
      return;
    }

    const { supplierCode, productId, qty } = ctx.session.pendingBuy;
    // Save emails in session instead of wiping
    ctx.session.state = 'AWAITING_CONFIRM';
    ctx.session.pendingBuy.emails = emails;

    // Proceed to pre-check with emails
    await buyPreCheck(ctx, supplierCode, productId, qty, emails);
    return;
  }

  // Handle explicit /cancel
  if (text.startsWith('/cancel')) {
    ctx.session.state = undefined;
    ctx.session.pendingBuy = undefined;
    await ctx.reply('Operation cancelled.');
    return;
  }

  // Must be a command
  if (!text.startsWith('/')) {
    await ctx.reply('Unrecognized input. Send a command like /help.');
    return;
  }

  const { command, error } = parseCommand(text);

  if (error) {
    await ctx.reply(`❌ ${error}`);
    return;
  }

  if (!command) return;

  try {
    switch (command.type) {
      case 'list':
        await listController(ctx, command.supplierCode!, command.search);
        break;
      case 'buy':
        await buyPreCheck(ctx, command.supplierCode!, command.productId!, command.qty!, command.emails);
        break;
      case 'status': {
        const tx = await prisma.transaction.findUnique({ where: { transactionId: command.txId } });
        if (!tx) {
          await ctx.reply(`❌ Transaction ${command.txId} not found.`);
          break;
        }
        await ctx.reply(
          `<b>TX Status: ${escapeHtml(command.txId || '')}</b>\n` +
          `Status: <code>${escapeHtml(tx.status)}</code>\n` +
          `Product: ${escapeHtml(tx.vlProductId)} (x${tx.qty})\n` +
          `Updated: ${escapeHtml(tx.updatedAt.toLocaleString())}\n` +
          `Error: ${escapeHtml(tx.lastError || 'None')}`,
          { parse_mode: 'HTML' }
        );
        break;
      }
      case 'pending': {
        const pending = await prisma.transaction.findMany({
          where: { status: { in: ['PENDING', 'SUPPLIER_OK', 'RECONCILING', 'VENDING_RETRY'] } },
          orderBy: { createdAt: 'desc' },
          take: 10,
        });
        if (pending.length === 0) {
          await ctx.reply('No pending transactions.');
          break;
        }
        let msg = `<b>Pending Transactions:</b>\n\n`;
        for (const tx of pending) {
          msg += `<code>${escapeHtml(tx.transactionId)}</code> - <code>${escapeHtml(tx.status)}</code>\n`;
        }
        await ctx.reply(msg, { parse_mode: 'HTML' });
        break;
      }
      case 'balance': {
        if (!command.supplierCode || command.supplierCode === 'ALL') {
          const adapters = supplierFactory.getAllAdapters();
          let msg = `💰 <b>Multi-Supplier Balances:</b>\n\n`;
          for (const adapter of adapters) {
            try {
              const bal = await adapter.getBalance();
              const formatted = (adapter.code === 'PDA' || adapter.code === 'DAI') ? `$${bal.toFixed(2)} USD` : `Rp${bal.toLocaleString('id-ID')}`;
              msg += `• <b>${escapeHtml(adapter.displayName)}</b> (<code>${escapeHtml(adapter.code)}</code>): ${formatted}\n`;
            } catch (err: any) {
              msg += `• <b>${escapeHtml(adapter.displayName)}</b> (<code>${escapeHtml(adapter.code)}</code>): ⚠️ Error (${escapeHtml(err.message)})\n`;
            }
          }
          await ctx.reply(msg, { parse_mode: 'HTML' });
          break;
        }

        const adapter = supplierFactory.getAdapter(command.supplierCode);
        const bal = await adapter.getBalance();
        const formatted = (adapter.code === 'PDA' || adapter.code === 'DAI') ? `$${bal.toFixed(2)} USD` : `Rp${bal.toLocaleString('id-ID')}`;
        await ctx.reply(`💰 <b>${escapeHtml(adapter.displayName)} Balance:</b>\n${formatted}`, { parse_mode: 'HTML' });
        break;
      }
      case 'suppliers': {
        const dbSuppliers = await prisma.supplier.findMany({
          orderBy: { createdAt: 'asc' },
        });
        let msg = `🏭 <b>Registered Dynamic & Built-In Suppliers:</b>\n\n`;
        msg += `<b>Built-In Adapters:</b>\n`;
        msg += `• <b>Rezeki Shop</b> (<code>RZK</code>): ✅ BUILT-IN\n`;
        msg += `• <b>Prime Digital</b> (<code>PDA</code>): ✅ BUILT-IN\n`;
        msg += `• <b>Digital AI Store</b> (<code>DAI</code>): ✅ BUILT-IN\n\n`;

        if (dbSuppliers.length === 0) {
          msg += `<i>Belum ada supplier dinamis terdaftar di database.</i>\n`;
        } else {
          msg += `<b>Dynamic Suppliers:</b>\n`;
          for (const s of dbSuppliers) {
            let statusBadge = '⏳ PENDING';
            if (s.status === 'ACTIVE') statusBadge = '✅ ACTIVE';
            else if (s.status === 'NEEDS_REVIEW') statusBadge = '⚠️ NEEDS_REVIEW';
            else if (s.status === 'PAUSED') statusBadge = '⏸️ PAUSED';
            else if (s.status === 'DEPRECATED') statusBadge = '❌ DEPRECATED';

            let balanceStr = '';
            if (s.status === 'ACTIVE' && supplierFactory.hasAdapter(s.code)) {
              try {
                const b = await supplierFactory.getAdapter(s.code).getBalance();
                balanceStr = ` | Saldo: Rp${b.toLocaleString('id-ID')}`;
              } catch {}
            }

            const errStr = s.lastError ? `\n   <i>Error: ${s.lastError.slice(0, 80)}...</i>` : '';
            msg += `• <b>${s.displayName}</b> (<code>${s.code}</code>): ${statusBadge}${balanceStr}${errStr}\n`;
          }
        }
        msg += `\n<i>Kelola supplier via Storefront Admin di /admin/suppliers</i>`;
        await ctx.reply(msg, { parse_mode: 'HTML' });
        break;
      }
      case 'agent': {
        const action = command.search || 'status';
        if (action === 'pause') {
          await agentGuardrailService.setPaused(true);
          await ctx.reply('⏸️ <b>Autonomous Purchasing Agent PAUSED</b>.\nEmergency kill switch engaged. Inbound requests will be rejected until resumed.', { parse_mode: 'HTML' });
        } else if (action === 'resume') {
          await agentGuardrailService.setPaused(false);
          await ctx.reply('▶️ <b>Autonomous Purchasing Agent RESUMED</b>.\nAgent is now accepting requests and evaluating offers.', { parse_mode: 'HTML' });
        } else {
          const s = agentGuardrailService.getSettings();
          await ctx.reply(
            `🤖 <b>Agent Guardrail Settings (P2a)</b>:\n\n` +
            `• Status: ${s.paused ? '⏸️ <b>PAUSED</b>' : s.enabled ? '✅ <b>ACTIVE</b>' : '❌ <b>DISABLED</b>'}\n` +
            `• Per-Request Cap: Rp${s.maxSpendPerRequest.toLocaleString('id-ID')}\n` +
            `• Daily Spend Cap: Rp${s.maxSpendPerDay.toLocaleString('id-ID')}\n` +
            `• Min Balance Floor: Rp${s.minBalanceFloor.toLocaleString('id-ID')}\n` +
            `• Allowed Suppliers: <code>${escapeHtml(s.allowedSuppliers.join(', '))}</code>\n` +
            `• High Value Threshold: Rp${s.highValueThreshold.toLocaleString('id-ID')}\n\n` +
            `Use <code>/agent pause</code> or <code>/agent resume</code> to control kill switch.`,
            { parse_mode: 'HTML' }
          );
        }
        break;
      }
      case 'retry': {
        const tx = await prisma.transaction.findUnique({ where: { transactionId: command.txId } });
        if (!tx) {
          await ctx.reply(`❌ Transaction ${command.txId} not found.`);
          break;
        }
        if (tx.status === 'COMPLETED') {
          await ctx.reply(`✅ Transaction is already COMPLETED.`);
          break;
        }
        
        // Reset state for retry
        await prisma.transaction.update({
          where: { id: tx.id },
          data: { status: 'VENDING_RETRY', deliveryAttempts: 0, lastError: null },
        });

        // Enqueue to VendingDeliveryQueue
        const { vendingDeliveryQueue } = require('../queues/queues');
        await vendingDeliveryQueue.add('deliver', { txId: tx.id }, { jobId: tx.transactionId + '-' + Date.now() });

        await ctx.reply(`🔄 Forced retry initiated for TX ${command.txId}. Enqueued for delivery.`);
        break;
      }
      case 'map':
        await mapController(ctx, command);
        break;
      case 'help':
        await ctx.reply(
          '🤖 <b>VendingLink Bridge</b>\n\n' +
          'Commands:\n' +
          '• <code>/list &lt;SUPPLIER&gt; [search]</code> - List products\n' +
          '• <code>/buy &lt;SUPPLIER&gt; &lt;PRODUCT_ID&gt; [QTY] [emails]</code> - Buy products\n' +
          '• <code>/balance [SUPPLIER|ALL]</code> - Check balances across suppliers\n' +
          '• <code>/suppliers</code> - List dynamic and built-in suppliers\n' +
          '• <code>/agent [pause|resume|status]</code> - Control autonomous procurement kill switch\n' +
          '• <code>/status &lt;TX_ID&gt;</code> - Check tx status\n' +
          '• <code>/pending</code> - List pending tx\n' +
          '• <code>/retry &lt;TX_ID&gt;</code> - Force retry to VendingLink\n' +
          '• <code>/map &lt;SUPPLIER&gt; &lt;PRODUCT_ID&gt;</code> - Map produk interaktif (pilih dari nama)\n' +
          '• <code>/map list [search]</code> - Lihat daftar produk VendingLink\n' +
          '• <code>/cancel</code> - Cancel current operation',
          { parse_mode: 'HTML' }
        );
        break;
    }
  } catch (err) {
    logger.error({ err, command }, 'Error processing command');
    await ctx.reply('⚠️ An internal error occurred.');
  }
};

