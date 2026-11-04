import type { proto, WACallEvent } from '@whiskeysockets/baileys';
import { type WAMessage, type ReplyToMessage, type WACallPayload, WAMessageAck, AckNames } from './types.js';

export function normalizeJid(jid?: string | null): string {
  if (!jid) return '';
  // Clean device suffix (e.g. 1234567890:12@s.whatsapp.net -> 1234567890@s.whatsapp.net)
  const cleaned = jid.replace(/:[0-9]+@/, '@');
  // Convert @s.whatsapp.net to @c.us for WAHA compatibility
  if (cleaned.endsWith('@s.whatsapp.net')) {
    return cleaned.replace('@s.whatsapp.net', '@c.us');
  }
  if (!cleaned.includes('@')) {
    return `${cleaned}@c.us`;
  }
  return cleaned;
}

export function buildMessageId(fromMe: boolean, remoteJid: string, id: string): string {
  return `${fromMe}_${normalizeJid(remoteJid)}_${id}`;
}

export function parseMessageId(serializedId: string): { fromMe: boolean; remoteJid: string; id: string } {
  const parts = serializedId.split('_');
  if (parts.length >= 3) {
    const fromMe = parts[0] === 'true';
    const remoteJid = parts[1];
    const id = parts.slice(2).join('_');
    return { fromMe, remoteJid, id };
  }
  return { fromMe: false, remoteJid: '', id: serializedId };
}

export function extractBody(message?: proto.IMessage | null): string | null {
  if (!message) return null;

  if (message.conversation) {
    return message.conversation;
  }
  if (message.extendedTextMessage?.text) {
    return message.extendedTextMessage.text;
  }
  if (message.imageMessage?.caption) {
    return message.imageMessage.caption;
  }
  if (message.videoMessage?.caption) {
    return message.videoMessage.caption;
  }
  if (message.documentMessage?.caption) {
    return message.documentMessage.caption;
  }
  if (message.pollCreationMessage?.name) {
    return message.pollCreationMessage.name;
  }
  if (message.locationMessage?.name || message.locationMessage?.address) {
    return [message.locationMessage.name, message.locationMessage.address].filter(Boolean).join(' - ');
  }

  return null;
}

export function hasMediaContent(message?: proto.IMessage | null): boolean {
  if (!message) return false;
  return Boolean(
    message.imageMessage ||
    message.videoMessage ||
    message.audioMessage ||
    message.documentMessage ||
    message.stickerMessage
  );
}

export function extractReplyTo(message?: proto.IMessage | null): ReplyToMessage | null {
  if (!message) return null;

  // Check extendedTextMessage contextInfo
  const context =
    message.extendedTextMessage?.contextInfo ||
    message.imageMessage?.contextInfo ||
    message.videoMessage?.contextInfo ||
    message.documentMessage?.contextInfo;

  if (!context || !context.stanzaId) {
    return null;
  }

  return {
    id: context.stanzaId,
    participant: context.participant ? normalizeJid(context.participant) : undefined,
    body: context.quotedMessage ? extractBody(context.quotedMessage) || undefined : undefined,
  };
}

export function toWAMessage(msg: proto.IWebMessageInfo): WAMessage {
  const key = msg.key;
  const fromMe = Boolean(key.fromMe);
  const remoteJid = normalizeJid(key.remoteJid);
  const participant = key.participant ? normalizeJid(key.participant) : undefined;
  const messageId = buildMessageId(fromMe, remoteJid, key.id || '');

  const from = fromMe ? normalizeJid(msg.key.remoteJid) : (participant || remoteJid);
  const to = fromMe ? remoteJid : normalizeJid(msg.key.remoteJid);

  const targetJid = fromMe ? to : from;
  const phone = targetJid.replace(/(:[0-9]+)?@(s\.whatsapp\.net|c\.us|g\.us|lid)$/, '').replace(/[^0-9]/g, '') || null;
  const pushName = msg.pushName || (msg as any).verifiedBizName || null;

  const timestamp = typeof msg.messageTimestamp === 'number'
    ? msg.messageTimestamp
    : (msg.messageTimestamp as any)?.low || Math.floor(Date.now() / 1000);

  const rawStatus = (msg.status as any) || (fromMe ? 2 : 3);
  const ack = rawStatus in AckNames ? rawStatus : WAMessageAck.DEVICE;
  const ackName = AckNames[ack] || 'DEVICE';

  return {
    id: messageId,
    timestamp,
    from,
    fromMe,
    to,
    participant,
    phone,
    pushName,
    profilePictureUrl: null,
    contact: {
      id: targetJid,
      phone: phone || '',
      pushName,
      profilePictureUrl: null,
    },
    body: extractBody(msg.message),
    hasMedia: hasMediaContent(msg.message),
    mediaUrl: null,
    ack,
    ackName,
    replyTo: extractReplyTo(msg.message),
    _data: msg,
  };
}

export const CALL_STATUS_EVENT_MAP: Record<string, string> = {
  offer: 'call.received',
  ringing: 'call.ringing',
  accept: 'call.accepted',
  reject: 'call.rejected',
  timeout: 'call.missed',
  terminate: 'call.ended',
};

export function mapCallStatusToEvent(status?: string): string {
  if (!status || typeof status !== 'string') {
    return 'call.update';
  }
  return CALL_STATUS_EVENT_MAP[status.toLowerCase()] || 'call.update';
}

export function toWACallPayload(call: Partial<WACallEvent> | any): { event: string; payload: WACallPayload } {
  let callDate: Date;
  if (call?.date instanceof Date && !isNaN(call.date.getTime())) {
    callDate = call.date;
  } else if (call?.date !== undefined && call?.date !== null) {
    const parsed = new Date(call.date);
    callDate = !isNaN(parsed.getTime()) ? parsed : new Date();
  } else if (call?.timestamp !== undefined && call?.timestamp !== null) {
    const num = Number(call.timestamp);
    const ms = num < 10000000000 ? num * 1000 : num;
    const parsed = new Date(ms);
    callDate = !isNaN(parsed.getTime()) ? parsed : new Date();
  } else {
    callDate = new Date();
  }

  const rawStatus = typeof call?.status === 'string' ? call.status : (call?.status != null ? String(call.status) : 'unknown');
  const event = mapCallStatusToEvent(rawStatus);

  const payload: WACallPayload = {
    id: call?.id ? String(call.id) : '',
    from: call?.from ? String(call.from) : '',
    chatId: call?.chatId ? String(call.chatId) : (call?.from ? String(call.from) : ''),
    timestamp: callDate.getTime(),
    date: callDate.toISOString(),
    isVideo: Boolean(call?.isVideo),
    isGroup: Boolean(call?.isGroup),
    groupJid: call?.groupJid ? String(call.groupJid) : null,
    status: rawStatus,
    offline: Boolean(call?.offline),
  };

  if (typeof call?.latencyMs === 'number') {
    payload.latencyMs = call.latencyMs;
  }

  return { event, payload };
}
