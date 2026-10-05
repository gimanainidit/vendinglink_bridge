import { Telegraf } from 'telegraf';
import { env } from '../src/config/env';

const setup = async () => {
  const bot = new Telegraf(env.BOT_TOKEN);
  const webhookUrl = `${env.PUBLIC_BASE_URL}/webhook/telegram`;

  console.log(`Setting webhook to: ${webhookUrl}`);

  await bot.telegram.setWebhook(webhookUrl, {
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });

  await bot.telegram.setMyCommands([
    { command: 'list', description: 'List products for a supplier' },
    { command: 'buy', description: 'Buy a product' },
    { command: 'status', description: 'Check transaction status' },
    { command: 'pending', description: 'List pending transactions' },
    { command: 'balance', description: 'Check supplier balance' },
    { command: 'retry', description: 'Force retry a transaction' },
    { command: 'help', description: 'Show help message' },
  ]);

  console.log('Webhook and commands set successfully.');
};

setup().catch(console.error);
