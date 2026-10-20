import type { proto } from '@whiskeysockets/baileys';
import { type WAMessage, type ReplyToMessage, WAMessageAck, AckNames } from './types.js';

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
