import { supplierFactory } from '../suppliers/SupplierFactory';
import { agentGuardrailService } from './agentGuardrailService';
import { bot } from '../telegram/bot';
import { env } from '../config/env';
import { logger } from '../lib/logger';

export const runBalanceMonitor = async (): Promise<void> => {
  logger.info('Running periodic balance monitor check...');
  try {
    const settings = agentGuardrailService.getSettings();
    const floor = settings.minBalanceFloor;
    const adapters = supplierFactory.getAllAdapters();

    for (const adapter of adapters) {
      try {
        const balance = await adapter.getBalance();
        logger.debug({ code: adapter.code, balance, floor }, 'Supplier balance check');

        if (balance < floor) {
          const alertMsg =
            `⚠️ <b>[ALERT SALDO SUPPLIER RENDAH]</b>\n` +
            `Supplier: <b>${adapter.displayName}</b> (<code>${adapter.code}</code>)\n` +
            `Saldo saat ini: <b>Rp ${balance.toLocaleString('id-ID')}</b>\n` +
            `Ambang batas minimum: <b>Rp ${floor.toLocaleString('id-ID')}</b>\n\n` +
            `<i>Segera lakukan deposit/top-up agar transaksi pembelian otomatis tidak gagal!</i>`;

          logger.warn({ code: adapter.code, balance, floor }, 'Supplier balance below floor limit');

          if (env.ADMIN_TELEGRAM_ID) {
            const adminIds = env.ADMIN_TELEGRAM_ID.split(',').map((id) => id.trim());
            for (const adminId of adminIds) {
              await bot.telegram.sendMessage(adminId, alertMsg, { parse_mode: 'HTML' }).catch((e) => {
                logger.error({ err: e.message, adminId }, 'Failed to send Telegram low balance alert');
              });
            }
          }
        }
      } catch (err: any) {
        logger.warn({ code: adapter.code, err: err.message }, 'Failed to fetch balance in monitor check');
      }
    }
  } catch (err: any) {
    logger.error({ err }, 'Balance monitor run failed');
  }
};
