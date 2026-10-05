import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';

export const verifySecretMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers['x-telegram-bot-api-secret-token'];

  if (!token || typeof token !== 'string') {
    logger.warn('Missing or invalid X-Telegram-Bot-Api-Secret-Token');
    return res.status(401).send('Unauthorized');
  }

  try {
    const isMatch = timingSafeEqual(
      Buffer.from(token, 'utf8'),
      Buffer.from(env.TELEGRAM_WEBHOOK_SECRET, 'utf8')
    );

    if (!isMatch) {
      logger.warn('Mismatched X-Telegram-Bot-Api-Secret-Token');
      return res.status(401).send('Unauthorized');
    }
  } catch (error) {
    logger.warn('Error comparing secret tokens (length mismatch?)');
    return res.status(401).send('Unauthorized');
  }

  next();
};
