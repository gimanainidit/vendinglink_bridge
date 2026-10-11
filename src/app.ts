import express from 'express';
import path from 'path';
import fs from 'fs';
import pinoHttp from 'pino-http';
import { logger } from './lib/logger';
import { bot } from './telegram/bot';
import { verifySecretMiddleware } from './telegram/middleware/verifySecret';
import { requestsRouter } from './routes/requests.routes';

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
      .nav-bar { background: #263238; color: #fff; padding: 10px 20px; font-family: Roboto, sans-serif; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }
      .nav-bar a { color: #80cbc4; text-decoration: none; font-weight: bold; margin-left: 15px; }
      .nav-bar a:hover { text-decoration: underline; }
    </style>
  </head>
  <body>
    <div class="nav-bar">
      <span><strong>VendingLink Bridge</strong> — API Documentation</span>
      <div>
        <a href="/swagger">🚀 Open Interactive Swagger Console (Sandbox & Test)</a>
        <a href="/docs/openapi.yaml" target="_blank">📄 OpenAPI YAML</a>
      </div>
    </div>
    <redoc spec-url="/docs/openapi.yaml" expand-responses="201,409"></redoc>
    <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
  </body>
</html>`);
  });

  // Serve interactive Swagger UI for testing against Sandbox and Production
  const renderSwagger = (req: express.Request, res: express.Response) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>VendingLink Bridge — Interactive Swagger Console</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; padding: 0; background: #fafafa; font-family: sans-serif; }
    .nav-banner { background: #1b1b1b; color: white; padding: 10px 20px; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }
    .nav-banner a { color: #49cc90; text-decoration: none; font-weight: bold; margin-left: 15px; }
    .nav-banner a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="nav-banner">
    <span><strong>VendingLink Bridge</strong> — Swagger Sandbox & Interactive Console</span>
    <div>
      <a href="/docs">📖 Redoc View</a>
      <a href="/docs/openapi.yaml" target="_blank">📄 OpenAPI Spec</a>
    </div>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      SwaggerUIBundle({
        url: "/docs/openapi.yaml",
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        layout: "StandaloneLayout",
        persistAuthorization: true,
        displayRequestDuration: true,
        tryItOutEnabled: true
      });
    };
  </script>
</body>
</html>`);
  };

  app.get('/swagger', renderSwagger);
  app.get('/docs/swagger', renderSwagger);

  // Inbound API routes (P2a Agentic Purchasing)
  app.use('/api/v1/requests', requestsRouter);

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
