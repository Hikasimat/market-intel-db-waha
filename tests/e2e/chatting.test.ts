import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';

describe('Chatting Endpoints', () => {
  const app = createApp();

  it('POST /api/sendText should reject missing chatId', async () => {
    const res = await request(app)
      .post('/api/sendText')
      .send({ text: 'Hello' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('chatId');
  });

  it('POST /api/sendText should reject missing text', async () => {
    const res = await request(app)
      .post('/api/sendText')
      .send({ chatId: '1234567890@c.us' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('text');
  });

  it('POST /api/sendText should return error when session is not in WORKING state', async () => {
    const res = await request(app)
      .post('/api/sendText')
      .send({
        session: 'nonexistent-session',
        chatId: '1234567890@c.us',
        text: 'Hello world',
      });
    expect(res.status).toBe(500);
    expect(res.body.message).toContain("Session 'nonexistent-session' does not exist");
  });
});
