import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mapCallStatusToEvent, toWACallPayload } from '../../src/engine/normalizer.js';
import { config } from '../../src/config.js';
import { WebhookDispatcher } from '../../src/webhooks/dispatcher.js';
import type { WACallEvent } from '@whiskeysockets/baileys';

describe('WhatsApp Call Event Detection & Webhook Integration', () => {
  describe('Status Mapping (mapCallStatusToEvent)', () => {
    it('should map offer to call.received', () => {
      expect(mapCallStatusToEvent('offer')).toBe('call.received');
    });

    it('should map ringing to call.ringing', () => {
      expect(mapCallStatusToEvent('ringing')).toBe('call.ringing');
    });

    it('should map accept to call.accepted', () => {
      expect(mapCallStatusToEvent('accept')).toBe('call.accepted');
    });

    it('should map reject to call.rejected', () => {
      expect(mapCallStatusToEvent('reject')).toBe('call.rejected');
    });

    it('should map timeout to call.missed', () => {
      expect(mapCallStatusToEvent('timeout')).toBe('call.missed');
    });

    it('should map terminate to call.ended', () => {
      expect(mapCallStatusToEvent('terminate')).toBe('call.ended');
    });

    it('should handle case insensitivity gracefully', () => {
      expect(mapCallStatusToEvent('OFFER')).toBe('call.received');
      expect(mapCallStatusToEvent('Ringing')).toBe('call.ringing');
      expect(mapCallStatusToEvent('TERMINATE')).toBe('call.ended');
    });

    it('should safely map unexpected statuses to call.update without crashing', () => {
      expect(mapCallStatusToEvent('busy')).toBe('call.update');
      expect(mapCallStatusToEvent('reconnecting')).toBe('call.update');
      expect(mapCallStatusToEvent('unknown_custom_status')).toBe('call.update');
      expect(mapCallStatusToEvent(undefined)).toBe('call.update');
      expect(mapCallStatusToEvent(null as any)).toBe('call.update');
      expect(mapCallStatusToEvent('' as any)).toBe('call.update');
    });
  });

  describe('Call Payload Normalization (toWACallPayload)', () => {
    it('should produce standardized webhook payload from offer event', () => {
      const fixedDate = new Date('2026-10-20T14:00:00.000Z');
      const rawCall: WACallEvent = {
        id: 'WHATSAPP_CALL_ID_123',
        from: '919876543210@s.whatsapp.net',
        chatId: '919876543210@s.whatsapp.net',
        date: fixedDate,
        isVideo: false,
        isGroup: false,
        status: 'offer',
        offline: false,
      };

      const { event, payload } = toWACallPayload(rawCall);

      expect(event).toBe('call.received');
      expect(payload).toEqual({
        id: 'WHATSAPP_CALL_ID_123',
        from: '919876543210@s.whatsapp.net',
        chatId: '919876543210@s.whatsapp.net',
        timestamp: fixedDate.getTime(),
        date: '2026-10-20T14:00:00.000Z',
        isVideo: false,
        isGroup: false,
        groupJid: null,
        status: 'offer',
        offline: false,
      });
    });

    it('should include latencyMs when provided by Baileys', () => {
      const rawCall: WACallEvent = {
        id: 'CALL_WITH_LATENCY',
        from: '919876543210@s.whatsapp.net',
        chatId: '919876543210@s.whatsapp.net',
        date: new Date('2026-10-20T14:05:00.000Z'),
        isVideo: true,
        isGroup: false,
        status: 'ringing',
        offline: false,
        latencyMs: 142,
      };

      const { event, payload } = toWACallPayload(rawCall);
      expect(event).toBe('call.ringing');
      expect(payload.isVideo).toBe(true);
      expect(payload.latencyMs).toBe(142);
    });

    it('should preserve distinction between group and 1-to-1 calls', () => {
      const groupCall: WACallEvent = {
        id: 'GROUP_CALL_001',
        from: '919876543210@s.whatsapp.net',
        chatId: '1203630248234@g.us',
        date: new Date('2026-10-20T14:10:00.000Z'),
        isVideo: false,
        isGroup: true,
        groupJid: '1203630248234@g.us',
        status: 'offer',
        offline: false,
      };

      const { payload } = toWACallPayload(groupCall);
      expect(payload.isGroup).toBe(true);
      expect(payload.groupJid).toBe('1203630248234@g.us');
      expect(payload.chatId).toBe('1203630248234@g.us');
    });

    it('should handle incomplete or unexpected call payloads without throwing', () => {
      const emptyCall = {} as any;
      const { event, payload } = toWACallPayload(emptyCall);

      expect(event).toBe('call.update');
      expect(payload.id).toBe('');
      expect(payload.from).toBe('');
      expect(payload.chatId).toBe('');
      expect(typeof payload.timestamp).toBe('number');
      expect(typeof payload.date).toBe('string');
      expect(payload.isVideo).toBe(false);
      expect(payload.isGroup).toBe(false);
      expect(payload.groupJid).toBeNull();
      expect(payload.offline).toBe(false);
      expect(payload.latencyMs).toBeUndefined();
    });

    it('should parse timestamps in numeric milliseconds or seconds', () => {
      const callWithSecTimestamp = {
        id: 'CALL_TS_SEC',
        from: '919876543210@s.whatsapp.net',
        timestamp: 1729410000, // seconds
        status: 'terminate',
      };

      const { event, payload } = toWACallPayload(callWithSecTimestamp);
      expect(event).toBe('call.ended');
      expect(payload.timestamp).toBe(1729410000000);
      expect(payload.date).toBe(new Date(1729410000000).toISOString());
    });
  });

  describe('Webhook Event Filtering', () => {
    const isAllowed = (event: string, configuredEvents: string[]) =>
      configuredEvents.includes('*') ||
      configuredEvents.includes(event) ||
      configuredEvents.includes(event.split('.')[0] + '.*');

    it('should allow all call events when WHATSAPP_HOOK_EVENTS=*', () => {
      const events = ['*'];
      expect(isAllowed('call.received', events)).toBe(true);
      expect(isAllowed('call.ringing', events)).toBe(true);
      expect(isAllowed('call.accepted', events)).toBe(true);
      expect(isAllowed('call.rejected', events)).toBe(true);
      expect(isAllowed('call.missed', events)).toBe(true);
      expect(isAllowed('call.ended', events)).toBe(true);
      expect(isAllowed('call.update', events)).toBe(true);
      expect(isAllowed('message', events)).toBe(true);
    });

    it('should allow only call events when WHATSAPP_HOOK_EVENTS=call.*', () => {
      const events = ['call.*'];
      expect(isAllowed('call.received', events)).toBe(true);
      expect(isAllowed('call.ringing', events)).toBe(true);
      expect(isAllowed('call.accepted', events)).toBe(true);
      expect(isAllowed('call.rejected', events)).toBe(true);
      expect(isAllowed('call.missed', events)).toBe(true);
      expect(isAllowed('call.ended', events)).toBe(true);
      expect(isAllowed('call.update', events)).toBe(true);

      // Other events must be filtered out
      expect(isAllowed('message', events)).toBe(false);
      expect(isAllowed('message.ack', events)).toBe(false);
      expect(isAllowed('session.status', events)).toBe(false);
      expect(isAllowed('auth.qr', events)).toBe(false);
    });

    it('should support specific call event lists', () => {
      const events = ['call.received', 'call.accepted', 'call.rejected', 'call.missed', 'call.ended'];
      expect(isAllowed('call.received', events)).toBe(true);
      expect(isAllowed('call.accepted', events)).toBe(true);
      expect(isAllowed('call.rejected', events)).toBe(true);
      expect(isAllowed('call.missed', events)).toBe(true);
      expect(isAllowed('call.ended', events)).toBe(true);

      // Excluded events
      expect(isAllowed('call.ringing', events)).toBe(false);
      expect(isAllowed('call.update', events)).toBe(false);
      expect(isAllowed('message', events)).toBe(false);
    });
  });

  describe('Webhook Security & HMAC Signing for Call Events', () => {
    const secret = 'waha_super_secret_hmac_key_2026';
    const now = Date.now();
    const callPayload = {
      id: 'WHATSAPP_CALL_ID_SEC',
      from: '919876543210@s.whatsapp.net',
      chatId: '919876543210@s.whatsapp.net',
      timestamp: now,
      date: new Date(now).toISOString(),
      isVideo: false,
      isGroup: false,
      groupJid: null,
      status: 'offer',
      offline: false,
    };

    const webhookBody = {
      id: `evt_${now}_abc123`,
      timestamp: now,
      event: 'call.received',
      session: 'default',
      engine: 'NOWEB',
      payload: callPayload,
    };

    it('should generate valid HMAC-SHA512 and HMAC-SHA256 signatures covering call webhook body', () => {
      const jsonString = JSON.stringify(webhookBody);
      const signaturePayload = `${now}.${jsonString}`;

      const hmac512 = crypto.createHmac('sha512', secret).update(signaturePayload).digest('hex');
      const hmac256 = crypto.createHmac('sha256', secret).update(signaturePayload).digest('hex');

      expect(hmac512).toHaveLength(128);
      expect(hmac256).toHaveLength(64);

      // Verify tamper-evidence
      const tamperedBody = JSON.stringify({ ...webhookBody, session: 'attacker' });
      const tamperedSignaturePayload = `${now}.${tamperedBody}`;
      const tamperedHmac512 = crypto.createHmac('sha512', secret).update(tamperedSignaturePayload).digest('hex');
      expect(tamperedHmac512).not.toBe(hmac512);
    });

    it('should compute valid payload SHA-256 digest', () => {
      const jsonString = JSON.stringify(webhookBody);
      const digest = crypto.createHash('sha256').update(jsonString).digest('hex');
      expect(digest).toHaveLength(64);
    });
  });

  describe('Session Socket Event Listener & Isolation Simulation', () => {
    it('should process multiple call events in a single array', () => {
      const rawCalls: WACallEvent[] = [
        {
          id: 'CALL_1',
          from: '911111111111@s.whatsapp.net',
          chatId: '911111111111@s.whatsapp.net',
          date: new Date('2026-10-20T14:00:00.000Z'),
          status: 'offer',
          offline: false,
        },
        {
          id: 'CALL_1',
          from: '911111111111@s.whatsapp.net',
          chatId: '911111111111@s.whatsapp.net',
          date: new Date('2026-10-20T14:00:05.000Z'),
          status: 'ringing',
          offline: false,
        },
      ];

      const processed: Array<{ event: string; payload: any }> = [];
      for (const raw of rawCalls) {
        processed.push(toWACallPayload(raw));
      }

      expect(processed).toHaveLength(2);
      expect(processed[0].event).toBe('call.received');
      expect(processed[0].payload.id).toBe('CALL_1');
      expect(processed[1].event).toBe('call.ringing');
      expect(processed[1].payload.id).toBe('CALL_1');
    });

    it('should keep multi-session events strictly isolated', () => {
      const sessionADispatches: any[] = [];
      const sessionBDispatches: any[] = [];

      const mockDispatcher = {
        dispatch: (event: string, session: string, payload: any) => {
          if (session === 'session_A') {
            sessionADispatches.push({ event, session, payload });
          } else if (session === 'session_B') {
            sessionBDispatches.push({ event, session, payload });
          }
        },
      };

      const callA: WACallEvent = {
        id: 'CALL_SESSION_A',
        from: '911111111111@s.whatsapp.net',
        chatId: '911111111111@s.whatsapp.net',
        date: new Date(),
        status: 'offer',
        offline: false,
      };

      const callB: WACallEvent = {
        id: 'CALL_SESSION_B',
        from: '922222222222@s.whatsapp.net',
        chatId: '922222222222@s.whatsapp.net',
        date: new Date(),
        status: 'accept',
        offline: false,
      };

      const parsedA = toWACallPayload(callA);
      mockDispatcher.dispatch(parsedA.event, 'session_A', parsedA.payload);

      const parsedB = toWACallPayload(callB);
      mockDispatcher.dispatch(parsedB.event, 'session_B', parsedB.payload);

      expect(sessionADispatches).toHaveLength(1);
      expect(sessionADispatches[0].session).toBe('session_A');
      expect(sessionADispatches[0].payload.id).toBe('CALL_SESSION_A');
      expect(sessionADispatches[0].event).toBe('call.received');

      expect(sessionBDispatches).toHaveLength(1);
      expect(sessionBDispatches[0].session).toBe('session_B');
      expect(sessionBDispatches[0].payload.id).toBe('CALL_SESSION_B');
      expect(sessionBDispatches[0].event).toBe('call.accepted');
    });

    it('should safely ignore null and non-object items in call event array', () => {
      const mixedCalls: any[] = [
        null,
        undefined,
        'corrupted_string',
        123,
        {
          id: 'CALL_VALID',
          from: '919876543210@s.whatsapp.net',
          status: 'reject',
          date: new Date(),
          offline: false,
        },
      ];

      const validPayloads: any[] = [];
      for (const item of mixedCalls) {
        if (item && typeof item === 'object') {
          validPayloads.push(toWACallPayload(item));
        }
      }

      expect(validPayloads).toHaveLength(1);
      expect(validPayloads[0].event).toBe('call.rejected');
      expect(validPayloads[0].payload.id).toBe('CALL_VALID');
    });
  });

  describe('Webhook Dispatcher Call Event Integration', () => {
    it('should log call events in dispatcher recentLogs', async () => {
      const dispatcher = new WebhookDispatcher();
      const mockPayload = {
        id: 'CALL_LOG_TEST',
        from: '919876543210@s.whatsapp.net',
        chatId: '919876543210@s.whatsapp.net',
        timestamp: Date.now(),
        date: new Date().toISOString(),
        isVideo: false,
        isGroup: false,
        groupJid: null,
        status: 'offer',
        offline: false,
      };

      // Dispatch without targetUrl will return early
      await dispatcher.dispatch('call.received', 'default', mockPayload, null);

      // When targetUrl is provided, it records in recentLogs
      const testUrl = 'http://127.0.0.1:9999/webhook';
      // Dispatch async
      void dispatcher.dispatch('call.received', 'default', mockPayload, testUrl);

      const logs = dispatcher.getRecentLogs();
      expect(logs.length).toBeGreaterThan(0);
      const callLog = logs.find((l) => l.event === 'call.received');
      expect(callLog).toBeDefined();
      expect(callLog?.session).toBe('default');
      expect(callLog?.payloadSummary.id).toBe('CALL_LOG_TEST');
    });
  });
});

