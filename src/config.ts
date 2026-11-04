import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

// Load environment variables from .env if present
dotenv.config();
// works
export interface AppConfig {
  port: number;
  host: string;
  apiKey: string | null;
  baseUrl: string;
  sessionsDir: string;
  mediaDir: string;
  logLevel: string;
  logFormat: 'JSON' | 'PRETTY';
  deviceName: string;
  webhookUrl: string | null;
  webhookEvents: string[];
  webhookSecret: string | null;
  autoStartSession: string | null;
  dashboardUsername: string;
  dashboardPassword: string;
  dashboardAuthEnabled: boolean;
  callingEnabled: boolean;
  wacallsUrl: string;
  wacallsToken: string;
  /** Path to the embedded Go VoIP engine binary (spawned as a child process when present). */
  wacallsBinary: string;
  /** True when the engine URL was not explicitly configured, i.e. run it inside this container. */
  wacallsEmbedded: boolean;
}

export function loadConfig(): AppConfig {
  const port = parseInt(process.env.WHATSAPP_API_PORT || process.env.PORT || '3000', 10);
  const host = process.env.WHATSAPP_API_HOSTNAME || process.env.HOST || '0.0.0.0';
  const apiKey = process.env.WAHA_API_KEY?.trim() || null;
  const baseUrl = process.env.WAHA_BASE_URL || `http://localhost:${port}`;
  const sessionsDir = path.resolve(process.env.WAHA_SESSIONS_DIR || process.env.SESSIONS_DIR || './.sessions');
  const mediaDir = path.resolve(process.env.WHATSAPP_FILES_FOLDER || process.env.MEDIA_DIR || './.media');
  const logLevel = process.env.WAHA_LOG_LEVEL || process.env.LOG_LEVEL || 'info';
  const logFormat = (process.env.WAHA_LOG_FORMAT || process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'JSON' : 'PRETTY')).toUpperCase() as 'JSON' | 'PRETTY';
  const deviceName = process.env.WAHA_CLIENT_DEVICE_NAME || process.env.DEVICE_NAME || 'WAHA-Light';
  const webhookUrl = process.env.WHATSAPP_HOOK_URL?.trim() || process.env.WAHA_WEBHOOK_URL?.trim() || null;
  
  // Default to '*' so ALL events (QR, status, messages, acks, calls) are dispatched via webhook
  const rawEvents = process.env.WHATSAPP_HOOK_EVENTS?.trim() || process.env.WAHA_HOOK_EVENTS?.trim() || process.env.WAHA_WEBHOOK_EVENTS?.trim();
  const webhookEvents = rawEvents
    ? rawEvents.split(',').map((e) => e.trim()).filter(Boolean)
    : ['*'];

  const webhookSecret = process.env.WHATSAPP_HOOK_SECRET?.trim() || process.env.WAHA_WEBHOOK_SECRET?.trim() || process.env.WAHA_HOOK_SECRET?.trim() || null;
  const autoStartSession = process.env.WHATSAPP_START_SESSION?.trim() || 'default';

  // HTTP Basic Auth for UI dashboard
  const dashboardUsername = process.env.WAHA_DASHBOARD_USERNAME?.trim() || 'admin';
  const dashboardPassword = process.env.WAHA_DASHBOARD_PASSWORD?.trim() || apiKey || 'admin';
  const dashboardAuthEnabled = process.env.WAHA_DASHBOARD_AUTH !== 'false';

  // Live WhatsApp Voice Calling (WaCalls integration)
  const callingEnabled = process.env.CALLING_ENABLED === 'true';
  // The VoIP engine is bundled in this container and bridged onto the existing Baileys sessions
  // (no separate WhatsApp login / QR). An explicit WACALLS_INTERNAL_URL points at an external engine instead.
  const explicitWacallsUrl = process.env.WACALLS_INTERNAL_URL?.trim() || process.env.WACALLS_URL?.trim() || '';
  const wacallsUrl = explicitWacallsUrl || 'http://127.0.0.1:8080';
  const wacallsEmbedded = !explicitWacallsUrl || /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(explicitWacallsUrl);
  let wacallsToken = process.env.WACALLS_INTERNAL_TOKEN?.trim() || process.env.WACALLS_TOKEN?.trim() || '';
  if (callingEnabled && !wacallsToken) {
    // Shared secret between this process and the engine child process; regenerated on every start.
    wacallsToken = crypto.randomBytes(24).toString('hex');
  }
  const wacallsBinary = process.env.WACALLS_BINARY?.trim() || '/usr/local/bin/wacalls';

  return {
    port,
    host,
    apiKey,
    baseUrl,
    sessionsDir,
    mediaDir,
    logLevel,
    logFormat,
    deviceName,
    webhookUrl,
    webhookEvents,
    webhookSecret,
    autoStartSession,
    dashboardUsername,
    dashboardPassword,
    dashboardAuthEnabled,
    callingEnabled,
    wacallsUrl,
    wacallsToken,
    wacallsBinary,
    wacallsEmbedded,
  };
}

export const config = loadConfig();
