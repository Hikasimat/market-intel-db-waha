export enum SessionStatus {
  STOPPED = 'STOPPED',
  STARTING = 'STARTING',
  SCAN_QR_CODE = 'SCAN_QR_CODE',
  WORKING = 'WORKING',
  FAILED = 'FAILED',
}

export enum WAMessageAck {
  ERROR = 0,
  PENDING = 1,
  SERVER = 2,
  DEVICE = 3,
  READ = 4,
  PLAYED = 5,
}

export const AckNames: Record<number, string> = {
  0: 'ERROR',
  1: 'PENDING',
  2: 'SERVER',
  3: 'DEVICE',
  4: 'READ',
  5: 'PLAYED',
};

export interface MeInfo {
  id: string;
  name?: string;
  phone?: string;
}

export interface SessionInfo {
  name: string;
  status: SessionStatus;
  me: MeInfo | null;
}

export interface PairingCodeRequest {
  phoneNumber: string;
}

export interface PairingCodeResponse {
  code: string;
}

export interface QRCodeResponse {
  value: string;
}

export interface ReplyToMessage {
  id: string;
  participant?: string;
  body?: string;
}

export interface WAMessage {
  id: string;
  timestamp: number;
  from: string;
  fromMe: boolean;
  to: string;
  participant?: string;
  phone?: string | null;
  pushName?: string | null;
  profilePictureUrl?: string | null;
  contact?: {
    id: string;
    phone: string;
    pushName?: string | null;
    profilePictureUrl?: string | null;
  } | null;
  body: string | null;
  hasMedia: boolean;
  mediaUrl?: string | null;
  ack: number;
  ackName: string;
  replyTo?: ReplyToMessage | null;
  _data?: any;
}

export interface MessageTextRequest {
  session?: string;
  chatId: string;
  text: string;
  reply_to?: string | null;
  mentions?: string[];
}

export interface SendSeenRequest {
  session?: string;
  chatId: string;
  messageId?: string;
}

export interface MessageReactionRequest {
  session?: string;
  chatId: string;
  messageId: string;
  reaction: string;
}

export interface WebhookPayload<T = any> {
  id: string;
  timestamp: number;
  event: string;
  session: string;
  engine: string;
  payload: T;
}
