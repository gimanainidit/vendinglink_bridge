import { z } from 'zod';
import { env } from '../../config/env';

export type CommandType = 'list' | 'buy' | 'status' | 'pending' | 'balance' | 'retry' | 'map' | 'help';

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
      // /buy <SUPPLIER> <PRODUCT_ID> <QTY> [email1,email2]
      if (parts.length < 4) return { error: 'Usage: /buy <SUPPLIER_CODE> <PRODUCT_ID> <QTY> [emails...]' };
      
      const supplierCode = parts[1].toUpperCase();
      const productId = parts[2];
      const qtyRaw = parseInt(parts[3], 10);
      
      if (isNaN(qtyRaw) || qtyRaw < 1 || qtyRaw > env.MAX_BUY_QTY) {
        return { error: `Quantity must be an integer between 1 and ${env.MAX_BUY_QTY}` };
      }

      let emails: string[] | undefined;
      if (parts.length > 4) {
        const emailStr = parts[4];
        emails = emailStr.split(',').map(e => e.trim());
        for (const e of emails) {
          if (!emailSchema.safeParse(e).success) {
            return { error: `Invalid email format: ${e}` };
          }
        }
        if (emails.length !== qtyRaw) {
          return { error: `Provided ${emails.length} emails, but quantity is ${qtyRaw}. They must match.` };
        }
      }

      return { command: { type: 'buy', supplierCode, productId, qty: qtyRaw, emails } };
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
      if (parts.length < 2) return { error: 'Usage: /balance <SUPPLIER_CODE>' };
      return { command: { type: 'balance', supplierCode: parts[1].toUpperCase() } };
    }

    case '/help':
    case '/start':
      return { command: { type: 'help' } };

    case '/map': {
      // /map <SUPPLIER_CODE> <SUPPLIER_PRODUCT_ID> <VL_PRODUCT_ID>
      if (parts.length < 4) {
        return { error: 'Usage: /map <SUPPLIER_CODE> <SUPPLIER_PRODUCT_ID> <VL_PRODUCT_ID>' };
      }
      const supplierCode = parts[1].toUpperCase();
      const productId = parts[2];   // supplier-side product ID
      const vlProductId = parts[3]; // VendingLink-side product ID
      return { command: { type: 'map', supplierCode, productId, vlProductId } };
    }

    default:
      return { error: 'Unknown command. Type /help for usage.' };
  }
};
