import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.NODE_ENV === 'development' ? 'debug' : 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'botToken',
      '*.delivered_key',
      '*.delivered_keys',
      '*.BOT_TOKEN',
      '*.X-API-Key',
      '*.Authorization',
    ],
    censor: '[REDACTED]',
  },
  transport:
    env.NODE_ENV === 'development'
      ? {
          target: require.resolve('pino-pretty'),
          options: {
            colorize: true,
          },
        }
      : undefined,
});
