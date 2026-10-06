import express from 'express';
import path from 'path';
import fs from 'fs';
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

  // Serve raw OpenAPI spec
  app.get('/docs/openapi.yaml', (req, res) => {
    const yamlPath = path.resolve(process.cwd(), 'docs/openapi.yaml');
    if (fs.existsSync(yamlPath)) {
      res.setHeader('Content-Type', 'text/yaml');
      res.sendFile(yamlPath);
    } else {
      res.status(404).send('Spec not found');
    }
  });

  // Serve interactive Redoc UI
  app.get('/docs', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html>
  <head>
    <title>VendingLink Bridge Ingress API Docs</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet">
    <style>
      body { margin: 0; padding: 0; }
    </style>
  </head>
  <body>
    <redoc spec-url="/docs/openapi.yaml" expand-responses="200,409"></redoc>
    <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
  </body>
</html>`);
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
