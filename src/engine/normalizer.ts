import { extractMessageContent, type proto, type WACallEvent } from '@whiskeysockets/baileys';
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
  const content = extractMessageContent(message) || message;

  if (content.conversation) {
    return content.conversation;
  }
  if (content.extendedTextMessage?.text) {
    return content.extendedTextMessage.text;
  }
  if (content.imageMessage?.caption) {
    return content.imageMessage.caption;
  }
  if (content.videoMessage?.caption) {
    return content.videoMessage.caption;
  }
  if (content.documentMessage?.caption) {
    return content.documentMessage.caption;
  }
  if (content.pollCreationMessage?.name) {
    return content.pollCreationMessage.name;
  }
  if (content.locationMessage?.name || content.locationMessage?.address) {
    return [content.locationMessage.name, content.locationMessage.address].filter(Boolean).join(' - ');
  }
  if ((content as any).buttonsResponseMessage?.selectedDisplayText) {
    return (content as any).buttonsResponseMessage.selectedDisplayText;
  }
  if ((content as any).templateButtonReplyMessage?.selectedDisplayText) {
    return (content as any).templateButtonReplyMessage.selectedDisplayText;
  }
  if ((content as any).listResponseMessage?.title) {
    return (content as any).listResponseMessage.title;
  }

  return null;
}

export function hasMediaContent(message?: proto.IMessage | null): boolean {
  if (!message) return false;
  const content = extractMessageContent(message) || message;
  return Boolean(
    content.imageMessage ||
    content.videoMessage ||
    content.audioMessage ||
    content.documentMessage ||
    content.stickerMessage
  );
}

export function extractReplyTo(message?: proto.IMessage | null): ReplyToMessage | null {
  if (!message) return null;
  const content = extractMessageContent(message) || message;

  // Check extendedTextMessage contextInfo
  const context =
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    content.documentMessage?.contextInfo;

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
  const rawParticipant = key.participant || (msg as any).participant;
  const participant = rawParticipant ? normalizeJid(rawParticipant) : undefined;
  const isGroup = remoteJid.endsWith('@g.us');
  const messageId = buildMessageId(fromMe, remoteJid, key.id || '');

  // In WAHA:
  // - chatId: always the chat JID (remoteJid: group JID for groups, contact JID for direct chat)
  // - from: sender JID; for groups, participant (if inbound) or group JID
  // - to: target JID
  // - author / participant: the group member who sent the message
  const from = fromMe ? normalizeJid(msg.key.remoteJid) : (isGroup ? (participant || remoteJid) : remoteJid);
  const to = fromMe ? remoteJid : normalizeJid(msg.key.remoteJid);

  const targetJid = fromMe ? to : from;
  const phone = (participant || targetJid).replace(/(:[0-9]+)?@(s\.whatsapp\.net|c\.us|g\.us|lid)$/, '').replace(/[^0-9]/g, '') || null;
  const pushName = msg.pushName || (msg as any).verifiedBizName || null;

  const timestamp = typeof msg.messageTimestamp === 'number'
    ? msg.messageTimestamp
    : (msg.messageTimestamp as any)?.low || Math.floor(Date.now() / 1000);

  const rawStatus = (msg.status as any) || (fromMe ? 2 : 3);
  const ack = rawStatus in AckNames ? rawStatus : WAMessageAck.DEVICE;
  const ackName = AckNames[ack] || 'DEVICE';

  return {
    id: messageId,
    rawId: key.id || '',
    chatId: remoteJid,
    timestamp,
    from,
    fromMe,
    to,
    participant,
    author: participant,
    phone,
    pushName,
    profilePictureUrl: null,
    contact: {
      id: participant || targetJid,
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
