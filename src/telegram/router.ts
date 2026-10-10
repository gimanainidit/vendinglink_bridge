import { parseCommand } from './parser/commandParser';
import { MyContext } from './middleware/session';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { supplierFactory } from '../suppliers/SupplierFactory';
import { env } from '../config/env';
import { prisma } from '../db';

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

    let msg = `📦 <b>${adapter.displayName} Products:</b>\n\n`;
    for (const p of products.slice(0, 15)) {
      const status = p.availability === 'in_stock' ? '✅' : '❌';
      const emailBadge = p.requiresEmail ? ' 📧' : '';
      const safeName = p.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      msg += `${status} <code>${p.id}</code> - ${safeName}${emailBadge} - Rp${p.price?.toLocaleString('id-ID') || '?'}\n`;
    }
    
    if (products.length > 15) {
      msg += `\n<i>...and ${products.length - 15} more. Gunakan: /list RZK &lt;keyword&gt; untuk filter.</i>`;
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

    let msg = `🛒 *Confirm Purchase*\n\n`;
    msg += `Supplier: ${adapter.displayName}\n`;
    msg += `Product: ${product.name}\n`;
    msg += `Qty: ${qty}\n`;
    if (emails && emails.length > 0) {
      msg += `Emails: ${emails.join(', ')}\n`;
    }
    msg += `Total: Rp${total.toLocaleString('id-ID')}\n`;
    msg += `Balance: Rp${balance.toLocaleString('id-ID')} → Rp${(balance - total).toLocaleString('id-ID')}\n`;

    if (balance < total) {
      await ctx.reply(`❌ Insufficient balance! \n${msg}`, { parse_mode: 'Markdown' });
      return;
    }

    await ctx.reply(msg, {
      parse_mode: 'Markdown',
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
          `*TX Status: ${command.txId}*\n` +
          `Status: \`${tx.status}\`\n` +
          `Product: ${tx.vlProductId} (x${tx.qty})\n` +
          `Updated: ${tx.updatedAt.toLocaleString()}\n` +
          `Error: ${tx.lastError || 'None'}`,
          { parse_mode: 'Markdown' }
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
        let msg = `*Pending Transactions:*\n\n`;
        for (const tx of pending) {
          msg += `\`${tx.transactionId}\` - ${tx.status}\n`;
        }
        await ctx.reply(msg, { parse_mode: 'Markdown' });
        break;
      }
      case 'balance': {
        const adapter = supplierFactory.getAdapter(command.supplierCode!);
        const bal = await adapter.getBalance();
        await ctx.reply(`💰 *${adapter.displayName} Balance:*\nRp${bal.toLocaleString('id-ID')}`, { parse_mode: 'Markdown' });
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
      case 'map': {
        const supplierCode = command.supplierCode!;
        const supplierProductId = command.productId!;
        const vlProductId = command.vlProductId!;

        // Check for an existing mapping so we can report created vs updated.
        const existing = await prisma.productMapping.findUnique({
          where: {
            supplierCode_supplierProductId: { supplierCode, supplierProductId },
          },
        });

        await prisma.productMapping.upsert({
          where: {
            supplierCode_supplierProductId: { supplierCode, supplierProductId },
          },
          update: { vlProductId },
          create: { supplierCode, supplierProductId, vlProductId },
        });

        const action = existing
          ? `diperbarui (sebelumnya \`${existing.vlProductId}\`)`
          : 'dibuat';
        await ctx.reply(
          `✅ Mapping ${action}\n` +
          `Supplier: \`${supplierCode}\`\n` +
          `Supplier product ID: \`${supplierProductId}\`\n` +
          `VendingLink product ID: \`${vlProductId}\``,
          { parse_mode: 'Markdown' }
        );
        break;
      }
      case 'help':
        await ctx.reply(
          '🤖 *VendingLink Bridge*\n\n' +
          'Commands:\n' +
          '• `/list <SUPPLIER> [search]` - List products\n' +
          '• `/buy <SUPPLIER> <PRODUCT_ID> <QTY> [emails]` - Buy products\n' +
          '• `/balance <SUPPLIER>` - Check balance\n' +
          '• `/status <TX_ID>` - Check tx status\n' +
          '• `/pending` - List pending tx\n' +
          '• `/retry <TX_ID>` - Force retry to VendingLink\n' +
          '• `/map <SUPPLIER> <SUPPLIER_PRODUCT_ID> <VL_PRODUCT_ID>` - Register product mapping\n' +
          '• `/cancel` - Cancel current operation',
          { parse_mode: 'Markdown' }
        );
        break;
    }
  } catch (err) {
    logger.error({ err, command }, 'Error processing command');
    await ctx.reply('⚠️ An internal error occurred.');
  }
};
