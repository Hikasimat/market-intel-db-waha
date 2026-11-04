import QRCode from 'qrcode';
import { config } from '../config.js';
import { createChildLogger } from '../logger.js';
import { waCallsClient, WaCallsClient } from './wacalls-client.js';
import { waCallsEvents, WaCallsEventConsumer } from './event-consumer.js';
import type { WaCallsSession, WaCallsCallRecord } from './types.js';

const logger = createChildLogger('CallingService');

export class CallingService {
  private client: WaCallsClient;
  private events: WaCallsEventConsumer;
  private sessionMap: Map<string, string> = new Map(); // WAHA Session Name -> WaCalls Session ID

  constructor(client: WaCallsClient = waCallsClient, events: WaCallsEventConsumer = waCallsEvents) {
    this.client = client;
    this.events = events;
  }

  public init() {
    if (config.callingEnabled) {
      logger.info('Live calling subsystem initialized. Starting SSE event consumer...');
      this.events.start();
    } else {
      logger.info('Live calling subsystem is disabled (CALLING_ENABLED=false).');
    }
  }

  public shutdown() {
    this.events.stop();
  }

  public async getOrResolveCallingSession(wahaSessionName: string): Promise<WaCallsSession> {
    const existingSessions = await this.client.listSessions();
    
    // Look for a session named matching wahaSessionName or calling_<wahaSessionName>
    const match = existingSessions.find(
      (s) => s.name === wahaSessionName || s.name === `calling_${wahaSessionName}`
    );

    if (match) {
      this.sessionMap.set(wahaSessionName, match.id);
      this.events.registerSessionMapping(match.id, wahaSessionName);
      return match;
    }

    // Otherwise create one
    const callingName = `calling_${wahaSessionName}`;
    const newId = await this.client.createSession(callingName);
    this.sessionMap.set(wahaSessionName, newId);
    this.events.registerSessionMapping(newId, wahaSessionName);

    return {
      id: newId,
      name: callingName,
      jid: '',
      state: 'unpaired',
      paired: false,
    };
  }

  public async getSessionStatus(wahaSessionName: string): Promise<{
    enabled: boolean;
    wahaSession: string;
    callingSessionId: string | null;
    paired: boolean;
    state: string;
    jid: string;
  }> {
    if (!config.callingEnabled) {
      return {
        enabled: false,
        wahaSession: wahaSessionName,
        callingSessionId: null,
        paired: false,
        state: 'disabled',
        jid: '',
      };
    }

    try {
      const sess = await this.getOrResolveCallingSession(wahaSessionName);
      const auth = this.events.getAuthState(sess.id);
      return {
        enabled: true,
        wahaSession: wahaSessionName,
        callingSessionId: sess.id,
        paired: auth?.paired ?? sess.paired,
        state: auth?.state ?? sess.state,
        jid: sess.jid,
      };
    } catch (err: any) {
      logger.warn(`Failed to retrieve calling session status for ${wahaSessionName}: ${err.message}`);
      return {
        enabled: true,
        wahaSession: wahaSessionName,
        callingSessionId: null,
        paired: false,
        state: 'error: ' + err.message,
        jid: '',
      };
    }
  }

  public async pair(wahaSessionName: string): Promise<{ sessionId: string }> {
    const sess = await this.getOrResolveCallingSession(wahaSessionName);
    await this.client.pairSession(sess.id);
    return { sessionId: sess.id };
  }

  public async getQR(wahaSessionName: string): Promise<{ raw: string | null; base64: string | null }> {
    const sess = await this.getOrResolveCallingSession(wahaSessionName);
    const raw = this.events.getCachedQR(sess.id);
    let base64: string | null = null;
    if (raw) {
      try {
        base64 = await QRCode.toDataURL(raw);
      } catch {
        // ignore QR rendering errors
      }
    }
    return { raw, base64 };
  }

  public async startCall(wahaSessionName: string, phone: string, clientId?: string): Promise<{ callId: string }> {
    const sess = await this.getOrResolveCallingSession(wahaSessionName);
    const auth = this.events.getAuthState(sess.id);
    const isPaired = auth?.paired ?? sess.paired;
    if (!isPaired) {
      throw new Error(
        `Calling session for "${wahaSessionName}" is not paired to WhatsApp yet. Please visit ${config.baseUrl}/calls to link the calling session via QR code first.`
      );
    }
    return await this.client.startOutgoingCall(sess.id, phone, clientId);
  }

  public async exchangeWebRTC(wahaSessionName: string, callId: string, sdpOffer: string): Promise<{ sdpAnswer: string }> {
    const sess = await this.getOrResolveCallingSession(wahaSessionName);
    return await this.client.exchangeWebRTC(sess.id, callId, sdpOffer);
  }

  public async accept(wahaSessionName: string, callId: string, clientId?: string): Promise<{ callId: string }> {
    const sess = await this.getOrResolveCallingSession(wahaSessionName);
    return await this.client.acceptCall(sess.id, callId, clientId);
  }

  public async reject(wahaSessionName: string, callId: string): Promise<void> {
    const sess = await this.getOrResolveCallingSession(wahaSessionName);
    await this.client.rejectCall(sess.id, callId);
  }

  public async hangup(wahaSessionName: string, callId: string): Promise<void> {
    const sess = await this.getOrResolveCallingSession(wahaSessionName);
    await this.client.endCall(sess.id, callId);
  }

  public async getHistory(wahaSessionName: string): Promise<WaCallsCallRecord[]> {
    const sess = await this.getOrResolveCallingSession(wahaSessionName);
    return await this.client.getHistory(sess.id);
  }
}

export const callingService = new CallingService();

