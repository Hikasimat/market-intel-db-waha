import { config } from '../config.js';
import { createChildLogger } from '../logger.js';
import type { WaCallsSession, WaCallsCallRecord } from './types.js';

const logger = createChildLogger('WaCallsClient');

export class WaCallsClient {
  private readonly baseUrl: string;
  private readonly internalToken: string;

  constructor(baseUrl: string = config.wacallsUrl, internalToken: string = config.wacallsToken) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.internalToken = internalToken;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra,
    };
    if (this.internalToken) {
      h['X-Internal-Token'] = this.internalToken;
      h['Authorization'] = `Bearer ${this.internalToken}`;
    }
    return h;
  }

  public async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  public async listSessions(): Promise<WaCallsSession[]> {
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`Failed to list WaCalls sessions: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { sessions: WaCallsSession[] };
    return data.sessions || [];
  }

  public async createSession(name: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to create WaCalls session: HTTP ${res.status} - ${err}`);
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  }

  public async deleteSession(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: this.headers(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete WaCalls session ${sessionId}: HTTP ${res.status}`);
    }
  }

  public async pairSession(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/pair`, {
      method: 'POST',
      headers: this.headers(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to pair WaCalls session ${sessionId}: HTTP ${res.status} - ${err}`);
    }
  }

  public async logoutSession(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/logout`, {
      method: 'POST',
      headers: this.headers(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to logout WaCalls session ${sessionId}: HTTP ${res.status}`);
    }
  }

  public async startOutgoingCall(sessionId: string, phone: string, clientId?: string): Promise<{ callId: string }> {
    const extraHeaders: Record<string, string> = {};
    if (clientId) {
      extraHeaders['X-Client-Id'] = clientId;
    }
    const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/calls`, {
      method: 'POST',
      headers: this.headers(extraHeaders),
      body: JSON.stringify({ phone }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to start outgoing call: HTTP ${res.status} - ${err}`);
    }
    const data = (await res.json()) as { call: { callId: string } };
    return { callId: data.call.callId };
  }

  public async exchangeWebRTC(sessionId: string, callId: string, sdpOffer: string): Promise<{ sdpAnswer: string }> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/calls/${encodeURIComponent(callId)}/webrtc`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ sdp_offer: sdpOffer }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to exchange WebRTC SDP: HTTP ${res.status} - ${err}`);
    }
    const data = (await res.json()) as { sdp_answer: string };
    return { sdpAnswer: data.sdp_answer };
  }

  public async acceptCall(sessionId: string, callId: string, clientId?: string): Promise<{ callId: string }> {
    const extraHeaders: Record<string, string> = {};
    if (clientId) {
      extraHeaders['X-Client-Id'] = clientId;
    }
    const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/calls/${encodeURIComponent(callId)}/accept`, {
      method: 'POST',
      headers: this.headers(extraHeaders),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to accept call: HTTP ${res.status} - ${err}`);
    }
    const data = (await res.json()) as { call: { callId: string } };
    return { callId: data.call.callId };
  }

  public async rejectCall(sessionId: string, callId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/calls/${encodeURIComponent(callId)}/reject`, {
      method: 'POST',
      headers: this.headers(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok && res.status !== 404) {
      const err = await res.text();
      throw new Error(`Failed to reject call: HTTP ${res.status} - ${err}`);
    }
  }

  public async endCall(sessionId: string, callId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/calls/${encodeURIComponent(callId)}`, {
      method: 'DELETE',
      headers: this.headers(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok && res.status !== 404) {
      const err = await res.text();
      throw new Error(`Failed to end call: HTTP ${res.status} - ${err}`);
    }
  }

  public async getHistory(sessionId: string): Promise<WaCallsCallRecord[]> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/history`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as { rows: WaCallsCallRecord[] };
    return data.rows || [];
  }
}

export const waCallsClient = new WaCallsClient();

