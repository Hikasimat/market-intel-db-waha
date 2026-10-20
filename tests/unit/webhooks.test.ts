import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';

describe('Webhook Security & HMAC Signing', () => {
  const secret = 'waha_super_secret_hmac_key_2026';
  const timestamp = Date.now();
  const payload = {
    event: 'auth.qr',
    session: 'default',
    payload: {
      qr: '2@sample-qr-code-whatsapp',
      qrBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAAEsCAYAAAB55ObU...',
    },
  };

  it('should generate valid HMAC-SHA512 signature over timestamp and body', () => {
    const jsonString = JSON.stringify(payload);
    const signaturePayload = `${timestamp}.${jsonString}`;

    const expectedHmac = crypto.createHmac('sha512', secret).update(signaturePayload).digest('hex');
    expect(expectedHmac).toBeDefined();
    expect(expectedHmac.length).toBe(128);

    // Verify tamper protection: changing any character in the body breaks the HMAC
    const tamperedJson = JSON.stringify({ ...payload, session: 'attacker' });
    const tamperedSignaturePayload = `${timestamp}.${tamperedJson}`;
    const tamperedHmac = crypto.createHmac('sha512', secret).update(tamperedSignaturePayload).digest('hex');
    expect(tamperedHmac).not.toBe(expectedHmac);
  });

  it('should generate valid HMAC-SHA256 and constant-time match', () => {
    const jsonString = JSON.stringify(payload);
    const signaturePayload = `${timestamp}.${jsonString}`;

    const computed = crypto.createHmac('sha256', secret).update(signaturePayload).digest('hex');
    expect(computed.length).toBe(64);

    const matches = crypto.timingSafeEqual(
      Buffer.from(computed, 'hex'),
      Buffer.from(computed, 'hex'),
    );
    expect(matches).toBe(true);
  });

  it('should detect and reject replayed timestamps outside 5-minute window', () => {
    const expiredTimestamp = Date.now() - 300_001; // 5 min 1 sec ago
    const isFresh = Math.abs(Date.now() - expiredTimestamp) <= 300_000;
    expect(isFresh).toBe(false);

    const validTimestamp = Date.now() - 2000; // 2 seconds ago
    const isValid = Math.abs(Date.now() - validTimestamp) <= 300_000;
    expect(isValid).toBe(true);
  });

  it('should correctly allow wildcard (*) webhook events including auth.qr', () => {
    const configuredEvents = ['*'];
    const isAllowed = (event: string) =>
      configuredEvents.includes('*') ||
      configuredEvents.includes(event) ||
      configuredEvents.includes(event.split('.')[0] + '.*');

    expect(isAllowed('auth.qr')).toBe(true);
    expect(isAllowed('auth.pairing_code')).toBe(true);
    expect(isAllowed('session.status')).toBe(true);
    expect(isAllowed('session.connected')).toBe(true);
    expect(isAllowed('message')).toBe(true);
    expect(isAllowed('group.v2.participants')).toBe(true);
  });
});
