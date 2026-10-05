import { Telegraf } from 'telegraf';
import { env } from '../config/env';
import { whitelistMiddleware } from './middleware/whitelist';
import { sessionMiddleware, MyContext } from './middleware/session';
import { handleTextMessage } from './router';
import { handleCallbackQuery } from './callbacks/confirmBuy';

export const bot = new Telegraf<MyContext>(env.BOT_TOKEN);

// Global Error Handler
bot.catch((err, ctx) => {
  console.error(`Ooops, encountered an error for ${ctx.updateType}`, err);
});

// Middleware pipeline
bot.use(whitelistMiddleware);
bot.use(sessionMiddleware());

// Routing
bot.on('message', handleTextMessage);
bot.on('callback_query', handleCallbackQuery);
