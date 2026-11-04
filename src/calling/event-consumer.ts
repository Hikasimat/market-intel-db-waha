import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { createChildLogger } from '../logger.js';
import { webhookDispatcher } from '../webhooks/dispatcher.js';
import type { WaCallsSSEEvent, VoiceCallWebhookPayload } from './types.js';

const logger = createChildLogger('WaCallsSSE');

export class WaCallsEventConsumer extends EventEmitter {
  private abortController: AbortController | null = null;
  private isRunning = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly baseUrl: string;
  private readonly internalToken: string;

  // SessionId -> Latest QR data
  private qrCache: Map<string, { qr: string; timestamp: number }> = new Map();
  // SessionId -> Auth state
  private authStateCache: Map<string, { paired: boolean; state: string }> = new Map();
  // CallId -> StartedAt timestamp
  private callStartTimes: Map<string, number> = new Map();
  // SessionId -> SessionName reverse mapping
  private sessionNameMap: Map<string, string> = new Map();

  constructor(baseUrl: string = config.wacallsUrl, internalToken: string = config.wacallsToken) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.internalToken = internalToken;
  }

  public registerSessionMapping(sessionId: string, sessionName: string) {
    this.sessionNameMap.set(sessionId, sessionName);
  }

  public getSessionName(sessionId: string): string {
    return this.sessionNameMap.get(sessionId) || sessionId;
  }

  public getCachedQR(sessionId: string): string | null {
    const cached = this.qrCache.get(sessionId);
    if (!cached) return null;
    // Expire QR after 60 seconds
    if (Date.now() - cached.timestamp > 60000) {
      this.qrCache.delete(sessionId);
      return null;
    }
    return cached.qr;
  }

  public getAuthState(sessionId: string): { paired: boolean; state: string } | null {
    return this.authStateCache.get(sessionId) || null;
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.connect();
  }

  public stop() {
    this.isRunning = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private connect() {
    if (!this.isRunning) return;

    this.abortController = new AbortController();
    const tokenParam = this.internalToken ? `?token=${encodeURIComponent(this.internalToken)}` : '';
    const url = `${this.baseUrl}/api/events${tokenParam}`;

    logger.info(`Connecting to WaCalls SSE event stream: ${url}`);

    fetch(url, {
      signal: this.abortController.signal,
      headers: this.internalToken
        ? {
            'X-Internal-Token': this.internalToken,
            Authorization: `Bearer ${this.internalToken}`,
          }
        : {},
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`SSE HTTP error: ${res.status}`);
        }
        if (!res.body) {
          throw new Error('SSE response body is null');
        }

        this.reconnectAttempts = 0;
        logger.info('Connected to WaCalls SSE stream');
        this.emit('connected');

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (this.isRunning) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:')) {
              const rawData = trimmed.slice(5).trim();
              if (rawData) {
                this.handleRawEvent(rawData);
              }
            }
          }
        }
      })
      .catch((err) => {
        if (!this.isRunning || err.name === 'AbortError') return;
        logger.warn(`WaCalls SSE connection lost: ${err.message}. Retrying...`);
        this.emit('disconnected', err);
        this.scheduleReconnect();
      });
  }

  private scheduleReconnect() {
    if (!this.isRunning || this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 15000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleRawEvent(rawData: string) {
    try {
      const event = JSON.parse(rawData) as WaCallsSSEEvent;
      logger.info({ eventType: event.type, event }, 'WaCalls SSE event received');
      this.emit('raw-event', event);

      switch (event.type) {
        case 'session-qr': {
          this.qrCache.set(event.sessionId, { qr: event.qr, timestamp: Date.now() });
          const sessionName = this.getSessionName(event.sessionId);
          this.emit('session-qr', { sessionId: event.sessionId, sessionName, qr: event.qr });
          break;
        }

        case 'auth-state': {
          this.authStateCache.set(event.sessionId, { paired: event.paired, state: event.state });
          if (event.qr) {
            this.qrCache.set(event.sessionId, { qr: event.qr, timestamp: Date.now() });
          }
          const sessionName = this.getSessionName(event.sessionId);
          this.emit('auth-state', { sessionName, ...event });
          break;
        }

        case 'incoming': {
          const sessionName = this.getSessionName(event.sessionId);
          this.callStartTimes.set(event.id, event.offeredAt || Date.now());

          const payload: VoiceCallWebhookPayload = {
            callId: event.id,
            sessionId: event.sessionId,
            peer: event.peer,
            direction: 'inbound',
            status: 'incoming',
            startedAt: event.offeredAt || Date.now(),
          };

          logger.info({ session: sessionName, callId: event.id, peer: event.peer }, 'Incoming live voice call detected');
          this.emit('incoming', { sessionName, payload });
          webhookDispatcher.dispatch('call.voice.incoming', sessionName, payload);
          break;
        }

        case 'call-status': {
          const sessionName = this.getSessionName(event.sessionId);
          if (event.status === 'ringing') {
            const payload: VoiceCallWebhookPayload = {
              callId: event.id,
              sessionId: event.sessionId,
              peer: event.peer,
              direction: event.owner ? 'outbound' : 'inbound',
              status: 'ringing',
              startedAt: event.startedAt || Date.now(),
            };
            this.emit('call-ringing', { sessionName, payload });
            webhookDispatcher.dispatch('call.voice.ringing', sessionName, payload);
          } else if (event.status === 'connected') {
            const payload: VoiceCallWebhookPayload = {
              callId: event.id,
              sessionId: event.sessionId,
              peer: event.peer,
              direction: event.owner ? 'outbound' : 'inbound',
              status: 'active',
              startedAt: event.startedAt || Date.now(),
            };
            logger.info({ session: sessionName, callId: event.id }, 'Voice call reached ACTIVE media state');
            this.emit('call-active', { sessionName, payload });
            webhookDispatcher.dispatch('call.voice.active', sessionName, payload);
          }
          break;
        }

        case 'call-ended': {
          const sessionName = this.getSessionName(event.sessionId);
          const startedAt = this.callStartTimes.get(event.id);
          const endedAt = event.endedAt || Date.now();
          const durationMs = startedAt ? endedAt - startedAt : undefined;
          this.callStartTimes.delete(event.id);

          const payload: VoiceCallWebhookPayload = {
            callId: event.id,
            sessionId: event.sessionId,
            peer: '',
            direction: event.owner ? 'outbound' : 'inbound',
            status: 'ended',
            startedAt,
            endedAt,
            durationMs,
            reason: event.reason,
          };

          logger.info({ session: sessionName, callId: event.id, reason: event.reason, durationMs }, 'Voice call ended');
          this.emit('call-ended', { sessionName, payload });

          if (event.reason === 'declined' || event.reason === 'rejected') {
            webhookDispatcher.dispatch('call.voice.rejected', sessionName, payload);
          }
          webhookDispatcher.dispatch('call.voice.ended', sessionName, payload);
          break;
        }
      }
    } catch (err: any) {
      logger.error({ err, rawData }, 'Failed to parse WaCalls SSE event');
    }
  }
}

export const waCallsEvents = new WaCallsEventConsumer();
