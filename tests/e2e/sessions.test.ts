import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { sessionManager } from '../../src/manager/session-mgr.js';

describe('Sessions & Auth Endpoints', () => {
  const app = createApp();
  const testSession = 'test-session-1';

  afterAll(async () => {
    await sessionManager.deleteSession(testSession);
  });

  it('GET /api/sessions should return empty or list of sessions', async () => {
    const res = await request(app).get('/api/sessions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/sessions/:session for nonexistent session should return 404', async () => {
    const res = await request(app).get('/api/sessions/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.statusCode).toBe(404);
  });

  it('POST /api/sessions should create and start session', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .send({ name: testSession });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(testSession);
    expect(['STARTING', 'SCAN_QR_CODE', 'WORKING']).toContain(res.body.status);
  });

  it('GET /api/sessions/:session should now return the created session', async () => {
    const res = await request(app).get(`/api/sessions/${testSession}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(testSession);
  });

  it('POST /api/sessions/:session/stop should stop the session', async () => {
    const res = await request(app).post(`/api/sessions/${testSession}/stop`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('STOPPED');
  });

  it('GET /api/:session/auth/qr on stopped session should return 400 Bad Request', async () => {
    const res = await request(app).get(`/api/${testSession}/auth/qr`);
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('SCAN_QR_CODE');
  });

  it('DELETE /api/sessions/:session should delete the session', async () => {
    const res = await request(app).delete(`/api/sessions/${testSession}`);
    expect(res.status).toBe(204);

    const checkRes = await request(app).get(`/api/sessions/${testSession}`);
    expect(checkRes.status).toBe(404);
  });
});
