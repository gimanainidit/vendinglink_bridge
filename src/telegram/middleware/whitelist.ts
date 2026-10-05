import { Context } from 'telegraf';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';

const allowedIds = env.ADMIN_TELEGRAM_ID.split(',').map((id) => id.trim());

export const whitelistMiddleware = async (ctx: Context, next: () => Promise<void>) => {
  const userId = ctx.from?.id.toString();

  if (!userId || !allowedIds.includes(userId)) {
    logger.warn({ userId }, 'Unauthorized access attempt dropped');
    return; // Silently drop
  }

  if (ctx.chat?.type !== 'private') {
    logger.warn({ chatId: ctx.chat?.id }, 'Non-private chat access attempt dropped');
    return;
  }

  return next();
};
