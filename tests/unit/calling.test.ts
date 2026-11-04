import { nodeToJson, jsonToNode } from '../../src/calling/bridge.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WaCallsClient } from '../../src/calling/wacalls-client.js';
import { WaCallsEventConsumer } from '../../src/calling/event-consumer.js';
import { CallingService } from '../../src/calling/calling-service.js';
import { webhookDispatcher } from '../../src/webhooks/dispatcher.js';
import { config } from '../../src/config.js';

describe('WhatsApp Live Voice Calling Subsystem', () => {
  describe('WaCallsClient', () => {
    it('should attach X-Internal-Token and Authorization headers when token is provided', async () => {
      let capturedHeaders: HeadersInit | undefined;
      const originalFetch = global.fetch;

      global.fetch = vi.fn().mockImplementation(async (url: any, init: any) => {
        capturedHeaders = init?.headers;
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessions: [] }),
        } as any;
      });

      const client = new WaCallsClient('http://localhost:8080', 'secret_token_123');
      await client.listSessions();

      expect(capturedHeaders).toBeDefined();
      expect((capturedHeaders as any)['X-Internal-Token']).toBe('secret_token_123');
      expect((capturedHeaders as any)['Authorization']).toBe('Bearer secret_token_123');

      global.fetch = originalFetch;
    });

    it('should throw an error with HTTP status when request fails', async () => {
      const originalFetch = global.fetch;

      global.fetch = vi.fn().mockImplementation(async () => {
        return {
          ok: false,
          status: 404,
          text: async () => 'Not Found',
        } as any;
      });

      const client = new WaCallsClient('http://localhost:8080', 'token');
      await expect(client.listSessions()).rejects.toThrow('Failed to list WaCalls sessions: HTTP 404');

      global.fetch = originalFetch;
    });
  });

  describe('WaCallsEventConsumer', () => {
    let consumer: WaCallsEventConsumer;

    beforeEach(() => {
      consumer = new WaCallsEventConsumer('http://localhost:8080', 'token');
      consumer.registerSessionMapping('sess_abc_123', 'user_16');
    });

    afterEach(() => {
      consumer.stop();
      vi.restoreAllMocks();
    });

    it('should map incoming event to call.voice.incoming webhook', () => {
      const dispatchSpy = vi.spyOn(webhookDispatcher, 'dispatch').mockImplementation(() => {});

      (consumer as any).handleRawEvent(
        JSON.stringify({
          type: 'incoming',
          sessionId: 'sess_abc_123',
          id: 'call_999',
          peer: '1234567890@s.whatsapp.net',
          offeredAt: 1793774000000,
        })
      );

      expect(dispatchSpy).toHaveBeenCalledWith(
        'call.voice.incoming',
        'user_16',
        expect.objectContaining({
          callId: 'call_999',
          sessionId: 'sess_abc_123',
          peer: '1234567890@s.whatsapp.net',
          direction: 'inbound',
          status: 'incoming',
        })
      );
    });

    it('should map call-status connected event to call.voice.active webhook', () => {
      const dispatchSpy = vi.spyOn(webhookDispatcher, 'dispatch').mockImplementation(() => {});

      (consumer as any).handleRawEvent(
        JSON.stringify({
          type: 'call-status',
          sessionId: 'sess_abc_123',
          id: 'call_999',
          status: 'connected',
          peer: '1234567890@s.whatsapp.net',
          startedAt: 1793774000000,
        })
      );

      expect(dispatchSpy).toHaveBeenCalledWith(
        'call.voice.active',
        'user_16',
        expect.objectContaining({
          callId: 'call_999',
          status: 'active',
        })
      );
    });

    it('should map call-ended event to call.voice.ended webhook with duration', () => {
      const dispatchSpy = vi.spyOn(webhookDispatcher, 'dispatch').mockImplementation(() => {});

      // Simulate incoming call timestamp
      (consumer as any).callStartTimes.set('call_999', 1793774000000);

      (consumer as any).handleRawEvent(
        JSON.stringify({
          type: 'call-ended',
          sessionId: 'sess_abc_123',
          id: 'call_999',
          reason: 'user_ended',
          endedAt: 1793774025000,
        })
      );

      expect(dispatchSpy).toHaveBeenCalledWith(
        'call.voice.ended',
        'user_16',
        expect.objectContaining({
          callId: 'call_999',
          durationMs: 25000,
          reason: 'user_ended',
        })
      );
    });

    it('should cache QR code from session-qr event', () => {
      (consumer as any).handleRawEvent(
        JSON.stringify({
          type: 'session-qr',
          sessionId: 'sess_abc_123',
          qr: '2@sampleQRdata123456',
        })
      );

      const cached = consumer.getCachedQR('sess_abc_123');
      expect(cached).toBe('2@sampleQRdata123456');
    });
  });

  describe('CallingService', () => {
    it('should report calling disabled when CALLING_ENABLED=false', async () => {
      const originalEnabled = config.callingEnabled;
      (config as any).callingEnabled = false;

      const mockClient = { listSessions: vi.fn() } as any;
      const mockEvents = { getAuthState: vi.fn(), start: vi.fn(), stop: vi.fn() } as any;

      const service = new CallingService(mockClient, mockEvents);
      const status = await service.getSessionStatus('user_16');

      expect(status.enabled).toBe(false);
      expect(status.state).toBe('disabled');

      (config as any).callingEnabled = originalEnabled;
    });

    it('should reuse existing matching session when available', async () => {
      const mockClient = {
        listSessions: vi.fn().mockResolvedValue([
          { id: 'sess_existing_1', name: 'user_16', jid: '123@s.whatsapp.net', state: 'connected', paired: true },
        ]),
        createSession: vi.fn(),
      } as any;
      const mockEvents = { registerSessionMapping: vi.fn() } as any;

      const service = new CallingService(mockClient, mockEvents);
      const sess = await service.getOrResolveCallingSession('user_16');

      expect(sess.id).toBe('sess_existing_1');
      expect(mockClient.createSession).not.toHaveBeenCalled();
      expect(mockEvents.registerSessionMapping).toHaveBeenCalledWith('sess_existing_1', 'user_16');
    });

    it('should resolve the bridged calling_<session> engine session', async () => {
      const mockClient = {
        listSessions: vi.fn().mockResolvedValue([
          { id: 'bridged_1', name: 'calling_user_16', jid: '123:40@s.whatsapp.net', state: 'open', paired: true },
        ]),
      } as any;
      const mockEvents = { registerSessionMapping: vi.fn() } as any;

      const service = new CallingService(mockClient, mockEvents);
      const sess = await service.getOrResolveCallingSession('user_16');

      expect(sess.id).toBe('bridged_1');
      expect(mockEvents.registerSessionMapping).toHaveBeenCalledWith('bridged_1', 'user_16');
    });

    it('should fail clearly (and never create a separate login) when the WAHA session is not connected', async () => {
      const mockClient = {
        listSessions: vi.fn().mockResolvedValue([]),
        createSession: vi.fn(),
      } as any;
      const mockEvents = { registerSessionMapping: vi.fn() } as any;

      const service = new CallingService(mockClient, mockEvents);

      await expect(service.getOrResolveCallingSession('user_16')).rejects.toThrow('is not connected');
      expect(mockClient.createSession).not.toHaveBeenCalled();
    });
  });

  describe('CallingBridge node codec', () => {
    it('should round-trip binary nodes (attrs, string, bytes and nested children)', () => {
      const node: any = {
        tag: 'offer',
        attrs: { 'call-id': 'ABC', 'call-creator': '919876543210@s.whatsapp.net' },
        content: [
          { tag: 'enc', attrs: { type: 'pkmsg', v: '2' }, content: new Uint8Array([1, 2, 3, 250]) },
          { tag: 'video', attrs: {} },
          { tag: 'note', attrs: {}, content: 'hello' },
        ],
      };

      const json = nodeToJson(node);
      const back: any = jsonToNode(JSON.parse(JSON.stringify(json)));

      expect(back.tag).toBe('offer');
      expect(back.attrs['call-id']).toBe('ABC');
      expect(back.content).toHaveLength(3);
      expect(Buffer.from(back.content[0].content).equals(Buffer.from([1, 2, 3, 250]))).toBe(true);
      expect(back.content[1].content).toBeUndefined();
      expect(back.content[2].content).toBe('hello');
    });
  });
});

