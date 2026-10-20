import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';

describe('Server & Health Endpoints', () => {
  const app = createApp();

  it('GET / should reject unauthenticated requests with 401 and WWW-Authenticate', async () => {
    const res = await request(app).get('/').set('Accept', 'text/html');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Basic');
  });

  it('GET / should render HTML dashboard when valid Basic Auth credentials are provided', async () => {
    const creds = Buffer.from('admin:admin').toString('base64');
    const res = await request(app)
      .get('/')
      .set('Authorization', `Basic ${creds}`)
      .set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('WAHA-NoWeb-Light');
    expect(res.text).toContain('NOWEB (Baileys)');
  });

  it('GET / should return JSON service info when valid Basic Auth credentials are provided', async () => {
    const creds = Buffer.from('admin:admin').toString('base64');
    const res = await request(app)
      .get('/')
      .set('Authorization', `Basic ${creds}`)
      .set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.engine).toBe('NOWEB');
    expect(res.body.webhook).toBeDefined();
  });

  it('GET /ping should respond with pong', async () => {
    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
    expect(res.text).toBe('pong');
  });

  it('GET /health should return 200 with JSON payload', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.engine).toBe('NOWEB');
    expect(res.body.memory).toBeDefined();
    expect(res.body.memory.rssMb).toBeGreaterThan(0);
    expect(res.body.timestamp).toBeDefined();
  });

  it('GET /unknown-route should return 404 with structured JSON', async () => {
    const res = await request(app).get('/unknown-route');
    expect(res.status).toBe(404);
    expect(res.body.statusCode).toBe(404);
    expect(res.body.error).toBe('Not Found');
    expect(res.body.message).toContain('/unknown-route');
  });
});
