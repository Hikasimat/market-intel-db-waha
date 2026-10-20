import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { config } from '../../src/config.js';

describe('Media Files & Contacts Endpoints', () => {
  const app = createApp();
  const testSession = 'media-test-session';
  const testFilename = 'sample.txt';
  const sessionDir = path.join(config.mediaDir, testSession);
  const filePath = path.join(sessionDir, testFilename);

  beforeAll(async () => {
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(filePath, 'Hello world from sample media file', 'utf-8');
  });

  afterAll(async () => {
    try {
      await fs.rm(sessionDir, { recursive: true, force: true });
    } catch {}
  });

  it('GET /api/files/:session/:filename should serve media file with correct MIME type', async () => {
    const res = await request(app).get(`/api/files/${testSession}/${testFilename}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toBe('Hello world from sample media file');
  });

  it('GET /api/files/:session/:filename should return 404 for nonexistent file', async () => {
    const res = await request(app).get(`/api/files/${testSession}/missing.png`);
    expect(res.status).toBe(404);
  });

  it('GET /api/contacts/check-exists should reject missing phone parameter', async () => {
    const res = await request(app).get('/api/contacts/check-exists');
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('phone');
  });
});
