export interface WaCallsSession {
  id: string;
  name: string;
  jid: string;
  state: string;
  paired: boolean;
}

export interface WaCallsCallRecord {
  sessionId: string;
  callId: string;
  owner?: string | null;
  direction: 'inbound' | 'outbound';
  peer: string;
  startedAt: number;
  status: 'starting' | 'ringing' | 'connected' | 'ended';
  endedAt?: number;
  endReason?: string;
}

export type WaCallsSSEEvent =
  | { type: 'auth-state'; sessionId: string; paired: boolean; state: string; qr?: string }
  | { type: 'session-qr'; sessionId: string; qr: string }
  | { type: 'session-list'; sessions: WaCallsSession[] }
  | { type: 'incoming'; sessionId: string; id: string; peer: string; offeredAt: number }
  | { type: 'incoming-claimed'; sessionId: string; id: string; owner: string }
  | { type: 'call-status'; sessionId: string; id: string; owner?: string | null; direction?: 'inbound' | 'outbound'; status: 'starting' | 'ringing' | 'connected' | 'ended'; peer: string; startedAt: number }
  | { type: 'call-ended'; sessionId: string; id: string; owner?: string | null; direction?: 'inbound' | 'outbound'; peer?: string; reason?: string; endedAt: number }
  | { type: 'call-list'; calls: WaCallsCallRecord[] };

export interface VoiceCallWebhookPayload {
  id?: string;
  callId: string;
  from?: string;
  chatId?: string;
  peer: string;
  caller?: string;
  callerPhone?: string;
  direction: 'inbound' | 'outbound';
  status: string;
  session?: string;
  sessionId: string;
  timestamp?: number;
  date?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  reason?: string;
  isVideo?: boolean;
  isGroup?: boolean;
  groupJid?: string | null;
  offline?: boolean;
}

