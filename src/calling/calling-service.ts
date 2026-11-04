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

  /**
   * Resolves the calling-engine session bridged onto a WAHA (Baileys) session.
   * The engine has no WhatsApp login of its own: a session exists only while the matching
   * WAHA session is connected, and it reuses that session's QR/credentials.
   */
  public async getOrResolveCallingSession(wahaSessionName: string): Promise<WaCallsSession> {
    const existingSessions = await this.client.listSessions();

    const match = existingSessions.find(
      (s) => s.name === `calling_${wahaSessionName}` || s.name === wahaSessionName
    );

    if (!match) {
      throw new Error(
        `WhatsApp session "${wahaSessionName}" is not connected. Start it and scan its QR code first; ` +
          `voice calling reuses that same session.`
      );
    }

    this.sessionMap.set(wahaSessionName, match.id);
    this.events.registerSessionMapping(match.id, wahaSessionName);
    return match;
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
      logger.debug(`Calling session for ${wahaSessionName} unavailable: ${err.message}`);
      return {
        enabled: true,
        wahaSession: wahaSessionName,
        callingSessionId: null,
        paired: false,
        state: 'not_connected',
        jid: '',
      };
    }
  }

  public async startCall(wahaSessionName: string, phone: string, clientId?: string): Promise<{ callId: string }> {
    const sess = await this.getOrResolveCallingSession(wahaSessionName);
    const auth = this.events.getAuthState(sess.id);
    const isConnected = auth?.paired ?? sess.paired;
    if (!isConnected) {
      throw new Error(
        `WhatsApp session "${wahaSessionName}" is not connected right now. Wait for it to reconnect (or scan its QR) and retry.`
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
