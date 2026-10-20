import path from 'node:path';
import dotenv from 'dotenv';

// Load environment variables from .env if present
dotenv.config();

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
  const webhookUrl = process.env.WHATSAPP_HOOK_URL?.trim() || null;
  
  // Default to '*' so ALL events (QR, status, messages, acks) are dispatched via webhook
  const rawEvents = process.env.WHATSAPP_HOOK_EVENTS?.trim();
  const webhookEvents = rawEvents
    ? rawEvents.split(',').map((e) => e.trim()).filter(Boolean)
    : ['*'];

  const webhookSecret = process.env.WHATSAPP_HOOK_SECRET?.trim() || null;
  const autoStartSession = process.env.WHATSAPP_START_SESSION?.trim() || 'default';

  // HTTP Basic Auth for UI dashboard
  const dashboardUsername = process.env.WAHA_DASHBOARD_USERNAME?.trim() || 'admin';
  const dashboardPassword = process.env.WAHA_DASHBOARD_PASSWORD?.trim() || apiKey || 'admin';
  const dashboardAuthEnabled = process.env.WAHA_DASHBOARD_AUTH !== 'false';

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
  };
}

export const config = loadConfig();
