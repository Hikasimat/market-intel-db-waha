import crypto from 'node:crypto';
import axios from 'axios';
import { config } from '../config.js';
import { createChildLogger } from '../logger.js';
import type { WebhookPayload } from '../engine/types.js';

export interface WebhookLogEntry {
  id: string;
  timestamp: number;
  event: string;
  session: string;
  url: string;
  status: 'DELIVERED' | 'FAILED' | 'RETRYING';
  statusCode?: number;
  error?: string;
  durationMs: number;
  payloadSummary: any;
  hmacSignature?: string;
}

export class WebhookDispatcher {
  private logger = createChildLogger('Webhook');
  private recentLogs: WebhookLogEntry[] = [];
  private maxLogs = 60;
  private stats = {
    total: 0,
    delivered: 0,
    failed: 0,
  };

  public getRecentLogs(): WebhookLogEntry[] {
    return [...this.recentLogs];
  }

  public getStats() {
    return { ...this.stats };
  }

  public clearLogs() {
    this.recentLogs = [];
  }

  private addLog(entry: WebhookLogEntry) {
    this.recentLogs.unshift(entry);
    if (this.recentLogs.length > this.maxLogs) {
      this.recentLogs.pop();
    }
  }

  private updateLog(id: string, update: Partial<WebhookLogEntry>) {
    const item = this.recentLogs.find((l) => l.id === id);
    if (item) {
      Object.assign(item, update);
    }
  }

  public async dispatch<T>(
    event: string,
    session: string,
    payload: T,
    targetUrl: string | null = config.webhookUrl,
  ): Promise<void> {
    if (!targetUrl) {
      return;
    }

    // Check if event is in the allowed webhookEvents list (or '*' wildcard)
    const isAllowed =
      config.webhookEvents.includes('*') ||
      config.webhookEvents.includes(event) ||
      config.webhookEvents.includes(event.split('.')[0] + '.*');

    if (!isAllowed) {
      return;
    }

    const now = Date.now();
    const eventId = `evt_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const body: WebhookPayload<T> = {
      id: eventId,
      timestamp: now,
      event,
      session,
      engine: 'NOWEB',
      payload,
    };

    const jsonString = JSON.stringify(body);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Webhook-Request-Id': eventId,
      'X-Webhook-Timestamp': now.toString(),
      'X-Webhook-Event': event,
      'X-Webhook-Session': session,
    };

    // Cryptographic signatures: HMAC-SHA512 & HMAC-SHA256 over `${timestamp}.${body}`
    // Guarantees zero interference / tampering in transit and prevents replay attacks
    if (config.webhookSecret) {
      const signaturePayload = `${now}.${jsonString}`;
      const hmac512 = crypto
        .createHmac('sha512', config.webhookSecret)
        .update(signaturePayload)
        .digest('hex');
      const hmac256 = crypto
        .createHmac('sha256', config.webhookSecret)
        .update(signaturePayload)
        .digest('hex');
      headers['X-Webhook-HMAC'] = hmac512;
      headers['X-Webhook-HMAC-SHA512'] = hmac512;
      headers['X-Webhook-HMAC-SHA256'] = hmac256;
      headers['X-Webhook-Signature'] = `sha256=${hmac256}`;
    }

    // Always attach payload SHA-256 digest for integrity verification
    const digest = crypto.createHash('sha256').update(jsonString).digest('hex');
    headers['X-Webhook-Digest'] = `sha256=${digest}`;

    // Record initial dispatch in live log
    const logEntry: WebhookLogEntry = {
      id: eventId,
      timestamp: now,
      event,
      session,
      url: targetUrl,
      status: 'RETRYING',
      durationMs: 0,
      payloadSummary: payload,
      hmacSignature: headers['X-Webhook-HMAC'] || headers['X-Webhook-Digest'],
    };
    this.addLog(logEntry);
    this.stats.total++;

    this.logger.info({ event, session, url: targetUrl }, `🚀 Dispatching webhook: ${event} -> ${targetUrl}`);

    // Send asynchronously with exponential retry
    this.sendWithRetry(targetUrl, jsonString, headers, eventId, event);
  }

  private async sendWithRetry(
    url: string,
    data: string,
    headers: Record<string, string>,
    id: string,
    event: string,
    retries = 3,
  ): Promise<void> {
    const startTime = Date.now();
    let attempt = 0;
    while (attempt <= retries) {
      try {
        const res = await axios.post(url, data, {
          headers,
          timeout: 15000,
        });
        const durationMs = Date.now() - startTime;
        this.updateLog(id, {
          status: 'DELIVERED',
          statusCode: res.status,
          durationMs,
        });
        this.stats.delivered++;
        this.logger.debug({ id, event, status: res.status, durationMs }, `✅ Webhook delivered to ${url}`);
        return;
      } catch (err: any) {
        attempt++;
        if (attempt > retries) {
          const durationMs = Date.now() - startTime;
          const errorMsg = err.code ? `${err.code}: ${err.message}` : err.message;
          const statusCode = err.response?.status;
          this.updateLog(id, {
            status: 'FAILED',
            statusCode,
            error: errorMsg,
            durationMs,
          });
          this.stats.failed++;
          this.logger.warn({ id, event, error: errorMsg, durationMs }, `❌ Webhook delivery failed after ${retries} attempts: ${url}`);
          return;
        }
        const backoff = 1000 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  public async testWebhook(targetUrl: string = config.webhookUrl || ''): Promise<{
    success: boolean;
    statusCode?: number;
    error?: string;
    durationMs: number;
    targetUrl: string;
    headers: Record<string, string>;
  }> {
    if (!targetUrl) {
      throw new Error('No webhook destination URL configured');
    }

    const now = Date.now();
    const eventId = `test_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const testBody = {
      id: eventId,
      timestamp: now,
      event: 'system.ping',
      session: 'test',
      engine: 'NOWEB',
      payload: {
        message: 'WAHA-NoWeb-Light Webhook Diagnostic Test',
        time: new Date(now).toISOString(),
      },
    };

    const jsonString = JSON.stringify(testBody);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Webhook-Request-Id': eventId,
      'X-Webhook-Timestamp': now.toString(),
      'X-Webhook-Event': 'system.ping',
      'X-Webhook-Session': 'test',
    };

    if (config.webhookSecret) {
      const signaturePayload = `${now}.${jsonString}`;
      const hmac512 = crypto
        .createHmac('sha512', config.webhookSecret)
        .update(signaturePayload)
        .digest('hex');
      const hmac256 = crypto
        .createHmac('sha256', config.webhookSecret)
        .update(signaturePayload)
        .digest('hex');
      headers['X-Webhook-HMAC'] = hmac512;
      headers['X-Webhook-HMAC-SHA512'] = hmac512;
      headers['X-Webhook-HMAC-SHA256'] = hmac256;
      headers['X-Webhook-Signature'] = `sha256=${hmac256}`;
    }
    const digest = crypto.createHash('sha256').update(jsonString).digest('hex');
    headers['X-Webhook-Digest'] = `sha256=${digest}`;

    const startTime = Date.now();
    try {
      const res = await axios.post(targetUrl, jsonString, {
        headers,
        timeout: 10000,
      });
      const durationMs = Date.now() - startTime;
      return {
        success: true,
        statusCode: res.status,
        durationMs,
        targetUrl,
        headers,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      return {
        success: false,
        statusCode: err.response?.status,
        error: err.code ? `${err.code}: ${err.message}` : err.message,
        durationMs,
        targetUrl,
        headers,
      };
    }
  }
}

export const webhookDispatcher = new WebhookDispatcher();
