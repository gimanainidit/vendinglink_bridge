import { z } from 'zod';
import { env } from '../../config/env';

export type CommandType = 'list' | 'buy' | 'status' | 'pending' | 'balance' | 'retry' | 'map' | 'agent' | 'suppliers' | 'help';

export interface ParsedCommand {
  type: CommandType;
  supplierCode?: string;
  productId?: string;
  qty?: number;
  emails?: string[];
  txId?: string;
  search?: string;
  vlProductId?: string; // used by /map
}

const emailSchema = z.string().email();

export const parseCommand = (text: string): { command?: ParsedCommand; error?: string } => {
  const parts = text.trim().split(/\s+/);
  const cmdRaw = parts[0].toLowerCase();
  
  // Strip bot mention if present (e.g. /buy@botname)
  const cmd = cmdRaw.split('@')[0];

  switch (cmd) {
    case '/list': {
      if (parts.length < 2) return { error: 'Usage: /list <SUPPLIER_CODE> [search]' };
      const supplierCode = parts[1].toUpperCase();
      const search = parts.slice(2).join(' ');
      return { command: { type: 'list', supplierCode, search: search || undefined } };
    }
    
    case '/buy': {
      // /buy <SUPPLIER> <PRODUCT_ID> [QTY] [email1,email2]
      if (parts.length < 3) return { error: 'Usage: /buy <SUPPLIER_CODE> <PRODUCT_ID> [QTY] [emails...]' };
      
      const supplierCode = parts[1].toUpperCase();
      const productId = parts[2];

      let qty = 1;
      let emailIndex = -1;

      if (parts.length >= 4) {
        const potentialQty = parseInt(parts[3], 10);
        if (!isNaN(potentialQty)) {
          if (potentialQty < 1 || potentialQty > env.MAX_BUY_QTY) {
            return { error: `Quantity must be an integer between 1 and ${env.MAX_BUY_QTY}` };
          }
          qty = potentialQty;
          if (parts.length > 4) {
            emailIndex = 4;
          }
        } else {
          // If parts[3] is not a number, check if it's email(s) for default qty 1
          if (parts[3].includes('@')) {
            qty = 1;
            emailIndex = 3;
          } else {
            return { error: `Quantity must be an integer between 1 and ${env.MAX_BUY_QTY}` };
          }
        }
      }

      let emails: string[] | undefined;
      if (emailIndex !== -1 && parts[emailIndex]) {
        const emailStr = parts[emailIndex];
        emails = emailStr.split(',').map(e => e.trim());
        for (const e of emails) {
          if (!emailSchema.safeParse(e).success) {
            return { error: `Invalid email format: ${e}` };
          }
        }
        if (emails.length !== qty) {
          return { error: `Provided ${emails.length} emails, but quantity is ${qty}. They must match.` };
        }
      }

      return { command: { type: 'buy', supplierCode, productId, qty, emails } };
    }

    case '/status': {
      if (parts.length < 2) return { error: 'Usage: /status <TRANSACTION_ID>' };
      return { command: { type: 'status', txId: parts[1] } };
    }

    case '/retry': {
      if (parts.length < 2) return { error: 'Usage: /retry <TRANSACTION_ID>' };
      return { command: { type: 'retry', txId: parts[1] } };
    }

    case '/pending':
      return { command: { type: 'pending' } };

    case '/balance': {
      const supplierCode = parts.length > 1 ? parts[1].toUpperCase() : 'ALL';
      return { command: { type: 'balance', supplierCode } };
    }

    case '/help':
    case '/start':
      return { command: { type: 'help' } };

    case '/map': {
      // 1. /map or /map help
      if (parts.length === 1 || parts[1].toLowerCase() === 'help') {
        return { command: { type: 'map', search: 'help' } };
      }

      // 2. /map list [searchKeyword]
      if (parts[1].toLowerCase() === 'list') {
        const keyword = parts.slice(2).join(' ').trim();
        return { command: { type: 'map', search: 'list', vlProductId: keyword || undefined } };
      }

      // 3. /map <SUPPLIER> without product ID
      if (parts.length === 2) {
        return {
          error:
            'Penggunaan /map:\n' +
            '• /map list [kata kunci] — Lihat daftar produk VendingLink\n' +
            '• /map <SUPPLIER> <PRODUCT_ID> — Pilih produk VendingLink secara interaktif (dengan tombol)\n' +
            '• /map <SUPPLIER> <PRODUCT_ID> <VL_PRODUCT_ID atau Nama Produk> — Map langsung'
        };
      }

      // 4. /map <SUPPLIER> <PRODUCT_ID> (interactive selection)
      if (parts.length === 3) {
        const supplierCode = parts[1].toUpperCase();
        const productId = parts[2];
        return { command: { type: 'map', search: 'interactive', supplierCode, productId } };
      }

      // 5. /map <SUPPLIER> <PRODUCT_ID> <VL_PRODUCT_ID or NAME...>
      const supplierCode = parts[1].toUpperCase();
      const productId = parts[2];
      const target = parts.slice(3).join(' ').trim();
      return { command: { type: 'map', search: 'direct', supplierCode, productId, vlProductId: target } };
    }

    case '/suppliers': {
      const subAction = parts.length > 1 ? parts[1].toUpperCase() : undefined;
      return { command: { type: 'suppliers', supplierCode: subAction } };
    }

    case '/agent': {
      // /agent [pause|resume|status]
      const action = parts.length > 1 ? parts[1].toLowerCase() : 'status';
      if (!['pause', 'resume', 'status'].includes(action)) {
        return { error: 'Usage: /agent [pause|resume|status]' };
      }
      return { command: { type: 'agent', search: action } };
    }

    default:
      return { error: 'Unknown command. Type /help for usage.' };
  }
};
