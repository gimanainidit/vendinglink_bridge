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

const mapController = async (ctx: MyContext, command: ParsedCommand) => {
  const subAction = command.search; // 'help' | 'list' | 'interactive' | 'direct'

  // 1. HELP
  if (subAction === 'help') {
    await ctx.reply(
      '🗺️ <b>Panduan Pemetaan Produk (/map)</b>\n\n' +
      'Perintah ini menghubungkan produk di supplier dengan produk di katalog VendingLink:\n\n' +
      '1️⃣ <b>Lihat Produk VendingLink:</b>\n' +
      '<code>/map list [kata kunci]</code>\n' +
      '<i>Contoh: <code>/map list gemini</code> atau <code>/map list</code></i>\n\n' +
      '2️⃣ <b>Pilih Interaktif dengan Tombol (Rekomendasi):</b>\n' +
      '<code>/map &lt;SUPPLIER&gt; &lt;PRODUCT_ID&gt;</code>\n' +
      '<i>Contoh: <code>/map RZK 6a31035939dc014325da2c66</code></i>\n' +
      '👉 Bot akan mencari produk VendingLink yang cocok dan menampilkan tombol pilihan!\n\n' +
      '3️⃣ <b>Map Langsung dengan Nama atau ID:</b>\n' +
      '<code>/map &lt;SUPPLIER&gt; &lt;PRODUCT_ID&gt; &lt;Nama Produk atau ID&gt;</code>\n' +
      '<i>Contoh: <code>/map RZK 6a31035939dc014325da2c66 Gemini Pro</code></i>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  // 2. LIST
  if (subAction === 'list') {
    const keyword = command.vlProductId;
    await ctx.reply(`⏳ Mengambil daftar produk dari VendingLink${keyword ? ' untuk "' + escapeHtml(keyword) + '"' : ''}...`);
    const vlProducts = await fetchVendingLinkProducts(keyword, 20);

    if (vlProducts.length === 0) {
      await ctx.reply(
        `ℹ️ Tidak ada produk aktif ditemukan di VendingLink${keyword ? ' dengan kata kunci "' + escapeHtml(keyword) + '"' : ''}.\n` +
        `<i>Pastikan produk sudah ditambahkan dan aktif di Storefront Admin.</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    let msg = `📋 <b>Daftar Produk VendingLink:</b> (ditemukan ${vlProducts.length} produk)\n\n`;
    for (let i = 0; i < vlProducts.length; i++) {
      const p = vlProducts[i];
      const priceFormatted = `Rp${p.price.toLocaleString('id-ID')}`;
      msg += `<b>${i + 1}. ${escapeHtml(p.name)}</b>\n`;
      msg += `   • ID: <code>${escapeHtml(p.id)}</code>\n`;
      msg += `   • Harga: ${priceFormatted} | Tipe: ${escapeHtml(p.type)}\n\n`;
    }

    msg += `💡 <b>Cara Mapping Cepat:</b>\n`;
    msg += `Ketik: <code>/map &lt;SUPPLIER&gt; &lt;PRODUCT_ID&gt;</code> untuk memilih dengan tombol interaktif!`;
    await ctx.reply(msg, { parse_mode: 'HTML' });
    return;
  }

  // 3. INTERACTIVE (User only provided supplier and supplier product ID)
  if (subAction === 'interactive') {
    const supplierCode = command.supplierCode!;
    const productId = command.productId!;

    await ctx.reply('⏳ Menyiapkan data produk...');

    let supplierProductName = '';
    try {
      const adapter = supplierFactory.getAdapter(supplierCode);
      const supplierProduct = await adapter.getProduct(productId);
      if (supplierProduct) {
        supplierProductName = supplierProduct.name;
      }
    } catch {}

    // Search VendingLink for matching products
    // Try keywords from supplier product name first (e.g. Gemini, Canva, Netflix)
    let candidates: Array<{ id: string; name: string; price: number }> = [];
    if (supplierProductName) {
      const words = supplierProductName.replace(/[^a-zA-Z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
      for (const w of words.slice(0, 2)) {
        const matches = await fetchVendingLinkProducts(w, 8);
        for (const m of matches) {
          if (!candidates.some(c => c.id === m.id)) {
            candidates.push(m);
          }
        }
      }
    }

    // If still less than 5, fill with general active products
    if (candidates.length < 5) {
      const allVl = await fetchVendingLinkProducts(undefined, 10);
      for (const m of allVl) {
        if (!candidates.some(c => c.id === m.id)) {
          candidates.push(m);
        }
      }
    }

    if (candidates.length === 0) {
      await ctx.reply(
        `⚠️ Tidak dapat menemukan produk di katalog VendingLink (koneksi Storefront offline atau katalog kosong).\n\n` +
        `Anda tetap dapat memetakan langsung secara manual menggunakan ID:\n` +
        `<code>/map ${escapeHtml(supplierCode)} ${escapeHtml(productId)} &lt;VL_PRODUCT_ID&gt;</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const topOptions = candidates.slice(0, 6);
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

    const keyboard = topOptions.map((opt, i) => [
      {
        text: `${i + 1}. ${opt.name.length > 32 ? opt.name.slice(0, 30) + '..' : opt.name} (Rp${opt.price.toLocaleString('id-ID')})`,
        callback_data: `map_pick_${i}`,
      },
    ]);
    keyboard.push([{ text: '❌ Batal', callback_data: 'map_cancel' }]);

    let msg = `🗺️ <b>Pilih Produk VendingLink untuk Dimapping:</b>\n\n`;
    msg += `📦 <b>Supplier:</b> <code>${escapeHtml(supplierCode)}</code>\n`;
    msg += `🏷️ <b>Produk Supplier:</b> ${escapeHtml(supplierProductName || productId)} (<code>${escapeHtml(productId)}</code>)\n\n`;
    msg += `Silakan pilih produk VendingLink yang sesuai di bawah ini:`;

    await ctx.reply(msg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: keyboard,
      },
    });
    return;
  }

  // 4. DIRECT (User provided target name or ID)
  if (subAction === 'direct') {
    const supplierCode = command.supplierCode!;
    const supplierProductId = command.productId!;
    const target = command.vlProductId!;

    // Check if target matches product name in VendingLink
    const searchMatches = await fetchVendingLinkProducts(target, 5);

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
        `• <b>Produk VendingLink:</b> <b>${escapeHtml(match.name)}</b> (<code>${escapeHtml(match.id)}</code>)`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // If multiple matches by name, present interactive buttons
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

      const keyboard = searchMatches.map((opt, i) => [
        {
          text: `${i + 1}. ${opt.name.length > 32 ? opt.name.slice(0, 30) + '..' : opt.name} (Rp${opt.price.toLocaleString('id-ID')})`,
          callback_data: `map_pick_${i}`,
        },
      ]);
      keyboard.push([{ text: '❌ Batal', callback_data: 'map_cancel' }]);

      await ctx.reply(
        `🔍 Ditemukan ${searchMatches.length} produk VendingLink yang cocok dengan "<i>${escapeHtml(target)}</i>".\nSilakan pilih salah satu:`,
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
      `• <b>VendingLink Product ID:</b> <code>${escapeHtml(target)}</code>`,
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
          agentGuardrailService.setPaused(true);
          await ctx.reply('⏸️ <b>Autonomous Purchasing Agent PAUSED</b>.\nEmergency kill switch engaged. Inbound requests will be rejected until resumed.', { parse_mode: 'HTML' });
        } else if (action === 'resume') {
          agentGuardrailService.setPaused(false);
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

