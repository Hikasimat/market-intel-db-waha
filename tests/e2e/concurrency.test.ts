import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { sessionManager } from '../../src/manager/session-mgr.js';
import { config } from '../../src/config.js';

describe('Multi-Session Concurrency & Isolation', () => {
  const app = createApp();
  const sessionAlpha = 'session-alpha-test';
  const sessionBeta = 'session-beta-test';

  afterAll(async () => {
    await sessionManager.deleteSession(sessionAlpha);
    await sessionManager.deleteSession(sessionBeta);
  });

  it('should initialize two concurrent sessions in separate isolated folders', async () => {
    const [resAlpha, resBeta] = await Promise.all([
      request(app).post('/api/sessions').send({ name: sessionAlpha }),
      request(app).post('/api/sessions').send({ name: sessionBeta }),
    ]);

    expect(resAlpha.status).toBe(201);
    expect(resBeta.status).toBe(201);
    expect(resAlpha.body.name).toBe(sessionAlpha);
    expect(resBeta.body.name).toBe(sessionBeta);

    // Verify separate directories
    const alphaPath = path.join(config.sessionsDir, sessionAlpha);
    const betaPath = path.join(config.sessionsDir, sessionBeta);

    const [alphaStat, betaStat] = await Promise.all([
      fs.stat(alphaPath),
      fs.stat(betaPath),
    ]);

    expect(alphaStat.isDirectory()).toBe(true);
    expect(betaStat.isDirectory()).toBe(true);
  }, 15000);

  it('should manage individual session statuses independently', async () => {
    // Stop alpha, keep beta starting
    const stopAlpha = await request(app).post(`/api/sessions/${sessionAlpha}/stop`);
    expect(stopAlpha.status).toBe(200);
    expect(stopAlpha.body.status).toBe('STOPPED');

    // Verify beta is unaffected
    const getBeta = await request(app).get(`/api/sessions/${sessionBeta}`);
    expect(getBeta.status).toBe(200);
    expect(['STARTING', 'SCAN_QR_CODE', 'WORKING']).toContain(getBeta.body.status);

    // Stop beta
    const stopBeta = await request(app).post(`/api/sessions/${sessionBeta}/stop`);
    expect(stopBeta.status).toBe(200);
    expect(stopBeta.body.status).toBe('STOPPED');
  });
});
