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
  // CallId -> Direction ('inbound' | 'outbound')
  private callDirections: Map<string, 'inbound' | 'outbound'> = new Map();
  // CallId -> Peer JID
  private callPeers: Map<string, string> = new Map();
  // SessionId -> SessionName reverse mapping
  private sessionNameMap: Map<string, string> = new Map();

  constructor(baseUrl: string = config.wacallsUrl, internalToken: string = config.wacallsToken) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.internalToken = internalToken;
  }

  public registerSessionMapping(sessionId: string, sessionName: string) {
    if (!sessionId || !sessionName) return;
    this.sessionNameMap.set(sessionId, sessionName);
    this.sessionNameMap.set(sessionName, sessionName);
    if (!sessionId.startsWith('calling_')) {
      this.sessionNameMap.set(`calling_${sessionId}`, sessionName);
    }
  }

  public getSessionName(sessionId: string): string {
    if (!sessionId) return 'default';
    if (this.sessionNameMap.has(sessionId)) {
      return this.sessionNameMap.get(sessionId)!;
    }
    if (sessionId.startsWith('calling_')) {
      const stripped = sessionId.slice(8);
      return this.sessionNameMap.get(stripped) || stripped;
    }
    for (const [key, name] of this.sessionNameMap.entries()) {
      if (key === sessionId || key.endsWith(sessionId) || sessionId.endsWith(key)) {
        return name;
      }
    }
    return sessionId;
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

        fetch(`${this.baseUrl}/api/sessions`, {
          headers: this.internalToken
            ? {
                'X-Internal-Token': this.internalToken,
                Authorization: `Bearer ${this.internalToken}`,
              }
            : {},
          signal: AbortSignal.timeout(3000),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((data: any) => {
            if (data && Array.isArray(data.sessions)) {
              for (const s of data.sessions) {
                if (s?.id && s?.name) {
                  const cleanName = s.name.replace(/^calling_/, '');
                  this.registerSessionMapping(s.id, cleanName);
                  this.registerSessionMapping(s.name, cleanName);
                }
              }
            }
          })
          .catch(() => {});

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
          const offeredAt = event.offeredAt || Date.now();
          this.callStartTimes.set(event.id, offeredAt);
          this.callDirections.set(event.id, 'inbound');
          if (event.peer) {
            this.callPeers.set(event.id, event.peer);
          }

          const cleanPhone = (event.peer || '').split('@')[0].split(':')[0].replace(/\D/g, '');
          const callerJid = event.peer?.includes('@') ? event.peer : (cleanPhone ? `${cleanPhone}@s.whatsapp.net` : '');
          const callDate = new Date(offeredAt);

          const basePayload = {
            id: event.id,
            callId: event.id,
            from: callerJid,
            chatId: callerJid,
            peer: event.peer || callerJid,
            caller: cleanPhone || event.peer,
            callerPhone: cleanPhone || event.peer,
            direction: 'inbound' as const,
            session: sessionName,
            sessionId: event.sessionId,
            timestamp: callDate.getTime(),
            date: callDate.toISOString(),
            startedAt: callDate.getTime(),
            isVideo: false,
            isGroup: false,
            groupJid: null,
            offline: false,
          };

          const wahaPayload: VoiceCallWebhookPayload = { ...basePayload, status: 'offer' };
          const voicePayload: VoiceCallWebhookPayload = { ...basePayload, status: 'incoming' };

          logger.info({ session: sessionName, callId: event.id, peer: event.peer }, 'Incoming live voice call detected');
          this.emit('incoming', { sessionName, payload: voicePayload });
          this.emit('call.received', { sessionName, payload: wahaPayload });

          // Dispatch standard WAHA incoming call webhook and voice incoming webhook
          webhookDispatcher.dispatch('call.received', sessionName, wahaPayload);
          webhookDispatcher.dispatch('call.voice.incoming', sessionName, voicePayload);
          break;
        }

        case 'call-status': {
          const sessionName = this.getSessionName(event.sessionId);
          const dir: 'inbound' | 'outbound' = event.direction || this.callDirections.get(event.id) || (event.owner ? 'outbound' : 'outbound');
          this.callDirections.set(event.id, dir);
          if (event.peer) {
            this.callPeers.set(event.id, event.peer);
          }

          const peer = event.peer || this.callPeers.get(event.id) || '';
          const cleanPhone = peer.split('@')[0].split(':')[0].replace(/\D/g, '');
          const callerJid = peer.includes('@') ? peer : (cleanPhone ? `${cleanPhone}@s.whatsapp.net` : '');
          const now = Date.now();
          const startedAt = event.startedAt || this.callStartTimes.get(event.id) || now;

          const basePayload = {
            id: event.id,
            callId: event.id,
            from: callerJid,
            chatId: callerJid,
            peer,
            caller: cleanPhone || peer,
            callerPhone: cleanPhone || peer,
            direction: dir,
            session: sessionName,
            sessionId: event.sessionId,
            timestamp: now,
            date: new Date(now).toISOString(),
            startedAt,
            isVideo: false,
            isGroup: false,
            groupJid: null,
            offline: false,
          };

          if (event.status === 'ringing') {
            const payload: VoiceCallWebhookPayload = {
              ...basePayload,
              status: 'ringing',
            };
            this.emit('call-ringing', { sessionName, payload });
            webhookDispatcher.dispatch('call.ringing', sessionName, payload);
            webhookDispatcher.dispatch('call.voice.ringing', sessionName, payload);
          } else if (event.status === 'connected') {
            const wahaPayload: VoiceCallWebhookPayload = { ...basePayload, status: 'accept' };
            const voicePayload: VoiceCallWebhookPayload = { ...basePayload, status: 'active' };

            logger.info({ session: sessionName, callId: event.id }, 'Voice call reached ACTIVE media state');
            this.emit('call-active', { sessionName, payload: voicePayload });
            webhookDispatcher.dispatch('call.accepted', sessionName, wahaPayload);
            webhookDispatcher.dispatch('call.voice.active', sessionName, voicePayload);
          }
          break;
        }

        case 'call-ended': {
          const sessionName = this.getSessionName(event.sessionId);
          const startedAt = this.callStartTimes.get(event.id);
          const endedAt = event.endedAt || Date.now();
          const durationMs = startedAt ? endedAt - startedAt : undefined;
          this.callStartTimes.delete(event.id);
          const dir: 'inbound' | 'outbound' = event.direction || this.callDirections.get(event.id) || (event.owner ? 'outbound' : 'outbound');
          this.callDirections.delete(event.id);

          const peer = event.peer || this.callPeers.get(event.id) || '';
          this.callPeers.delete(event.id);
          const cleanPhone = peer.split('@')[0].split(':')[0].replace(/\D/g, '');
          const callerJid = peer.includes('@') ? peer : (cleanPhone ? `${cleanPhone}@s.whatsapp.net` : '');

          const isRejected = event.reason === 'declined' || event.reason === 'rejected';
          const isMissed = event.reason === 'timeout' || event.reason === 'missed';
          const standardStatus = isRejected ? 'reject' : (isMissed ? 'timeout' : 'terminate');

          const basePayload = {
            id: event.id,
            callId: event.id,
            from: callerJid,
            chatId: callerJid,
            peer,
            caller: cleanPhone || peer,
            callerPhone: cleanPhone || peer,
            direction: dir,
            session: sessionName,
            sessionId: event.sessionId,
            timestamp: endedAt,
            date: new Date(endedAt).toISOString(),
            startedAt,
            endedAt,
            durationMs,
            reason: event.reason,
            isVideo: false,
            isGroup: false,
            groupJid: null,
            offline: false,
          };

          const wahaPayload: VoiceCallWebhookPayload = { ...basePayload, status: standardStatus };
          const voicePayload: VoiceCallWebhookPayload = { ...basePayload, status: 'ended' };

          logger.info({ session: sessionName, callId: event.id, reason: event.reason, durationMs }, 'Voice call ended');
          this.emit('call-ended', { sessionName, payload: voicePayload });

          if (isRejected) {
            webhookDispatcher.dispatch('call.rejected', sessionName, wahaPayload);
            webhookDispatcher.dispatch('call.voice.rejected', sessionName, voicePayload);
          } else if (isMissed) {
            webhookDispatcher.dispatch('call.missed', sessionName, wahaPayload);
            webhookDispatcher.dispatch('call.voice.missed', sessionName, voicePayload);
          }
          webhookDispatcher.dispatch('call.ended', sessionName, wahaPayload);
          webhookDispatcher.dispatch('call.voice.ended', sessionName, voicePayload);
          break;
        }
      }
    } catch (err: any) {
      logger.error({ err, rawData }, 'Failed to parse WaCalls SSE event');
    }
  }
}

export const waCallsEvents = new WaCallsEventConsumer();
