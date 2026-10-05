import express from 'express';
import pinoHttp from 'pino-http';
import { logger } from './lib/logger';
import { bot } from './telegram/bot';
import { verifySecretMiddleware } from './telegram/middleware/verifySecret';

export const createApp = () => {
  const app = express();

  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => req.url === '/health',
      },
    })
  );

  app.use(express.json());

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Telegram webhook will be mounted here
  app.post('/webhook/telegram', verifySecretMiddleware, bot.webhookCallback('/webhook/telegram'));

  // Global error handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.error({ err }, 'Unhandled error');
    // Telegram expects 200 OK even on failure, otherwise it retries
    if (req.url === '/webhook/telegram') {
      res.status(200).send('OK');
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return app;
};
