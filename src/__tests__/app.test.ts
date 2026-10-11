import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('../telegram/bot', () => ({
  bot: {
    webhookCallback: vi.fn(() => (req: any, res: any) => res.status(200).send('OK')),
  },
}));

import { createApp } from '../app';

describe('Express app routes', () => {
  const app = createApp();

  it('GET /health returns 200 OK', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /docs/openapi.yaml returns YAML content', async () => {
    const res = await request(app).get('/docs/openapi.yaml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/yaml');
    expect(res.text).toContain('openapi: 3.1.0');
    expect(res.text).toContain('/api/bridge/webhook/stock/topup');
  });

  it('GET /docs returns Redoc HTML documentation with Swagger link', async () => {
    const res = await request(app).get('/docs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('VendingLink Bridge Ingress API Docs');
    expect(res.text).toContain('/swagger');
  });

  it('GET /swagger returns interactive Swagger UI console for sandbox/prod testing', async () => {
    const res = await request(app).get('/swagger');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Swagger Sandbox & Interactive Console');
    expect(res.text).toContain('SwaggerUIBundle');
  });

  it('GET /docs/swagger alias also returns Swagger UI', async () => {
    const res = await request(app).get('/docs/swagger');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('SwaggerUIBundle');
  });
});
