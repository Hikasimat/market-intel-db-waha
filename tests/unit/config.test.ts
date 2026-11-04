import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('AppConfig', () => {
  it('should load default configuration values when env vars are absent', () => {
    const originalEnv = { ...process.env };
    delete process.env.PORT;
    delete process.env.WHATSAPP_API_PORT;
    delete process.env.WAHA_API_KEY;

    const conf = loadConfig();
    expect(conf.port).toBe(3000);
    expect(conf.host).toBe('0.0.0.0');
    expect(conf.apiKey).toBeNull();
    expect(conf.deviceName).toBe('WAHA-Light');
    expect(conf.webhookEvents).toContain('*');
    expect(conf.autoStartSession).toBe('default');
    expect(conf.callingEnabled).toBe(false);
    expect(conf.wacallsUrl).toBe('http://wacalls:8080');
    expect(conf.wacallsToken).toBe('');

    process.env = originalEnv;
  });

  it('should parse custom port and api key from environment', () => {
    const originalEnv = { ...process.env };
    process.env.PORT = '8080';
    process.env.WAHA_API_KEY = 'secret123';
    process.env.WHATSAPP_HOOK_URL = 'http://localhost:5000/hook';

    const conf = loadConfig();
    expect(conf.port).toBe(8080);
    expect(conf.apiKey).toBe('secret123');
    expect(conf.webhookUrl).toBe('http://localhost:5000/hook');

    process.env = originalEnv;
  });

  it('should accept WAHA_WEBHOOK_URL and WAHA_WEBHOOK_SECRET as aliases', () => {
    const originalEnv = { ...process.env };
    delete process.env.WHATSAPP_HOOK_URL;
    delete process.env.WHATSAPP_HOOK_SECRET;
    process.env.WAHA_WEBHOOK_URL = 'https://marketinteldbapp.hikasimat.com/api/whatsapp/webhook/';
    process.env.WAHA_WEBHOOK_SECRET = 'waha_secure_webhook_secret_2026';

    const conf = loadConfig();
    expect(conf.webhookUrl).toBe('https://marketinteldbapp.hikasimat.com/api/whatsapp/webhook/');
    expect(conf.webhookSecret).toBe('waha_secure_webhook_secret_2026');

    process.env = originalEnv;
  });
});
