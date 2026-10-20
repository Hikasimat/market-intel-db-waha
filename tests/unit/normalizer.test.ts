import { describe, it, expect } from 'vitest';
import {
  normalizeJid,
  buildMessageId,
  parseMessageId,
  extractBody,
  toWAMessage,
} from '../../src/engine/normalizer.js';
import { WAMessageAck } from '../../src/engine/types.js';

describe('Message Normalizer', () => {
  it('should normalize JIDs to WAHA @c.us format', () => {
    expect(normalizeJid('1234567890@s.whatsapp.net')).toBe('1234567890@c.us');
    expect(normalizeJid('1234567890:12@s.whatsapp.net')).toBe('1234567890@c.us');
    expect(normalizeJid('9876543210')).toBe('9876543210@c.us');
    expect(normalizeJid('1203630248234@g.us')).toBe('1203630248234@g.us');
  });

  it('should build and parse message IDs accurately', () => {
    const id = buildMessageId(false, '1234567890@s.whatsapp.net', '3EB0ABC123');
    expect(id).toBe('false_1234567890@c.us_3EB0ABC123');

    const parsed = parseMessageId(id);
    expect(parsed.fromMe).toBe(false);
    expect(parsed.remoteJid).toBe('1234567890@c.us');
    expect(parsed.id).toBe('3EB0ABC123');
  });

  it('should extract text from different message formats', () => {
    expect(extractBody({ conversation: 'Hello from raw' })).toBe('Hello from raw');
    expect(extractBody({ extendedTextMessage: { text: 'Hello extended' } })).toBe('Hello extended');
    expect(extractBody({ imageMessage: { caption: 'Photo caption' } })).toBe('Photo caption');
    expect(extractBody({ pollCreationMessage: { name: 'What is your favorite color?' } })).toBe('What is your favorite color?');
  });

  it('should convert proto.IWebMessageInfo into standardized WAMessage', () => {
    const mockMsg: any = {
      key: {
        remoteJid: '1234567890:2@s.whatsapp.net',
        fromMe: false,
        id: 'MSG12345',
      },
      message: {
        conversation: 'Test message content',
      },
      messageTimestamp: 1729410000,
      status: 3,
    };

    const wa = toWAMessage(mockMsg);
    expect(wa.id).toBe('false_1234567890@c.us_MSG12345');
    expect(wa.from).toBe('1234567890@c.us');
    expect(wa.fromMe).toBe(false);
    expect(wa.body).toBe('Test message content');
    expect(wa.timestamp).toBe(1729410000);
    expect(wa.hasMedia).toBe(false);
    expect(wa.ack).toBe(WAMessageAck.DEVICE);
    expect(wa.ackName).toBe('DEVICE');
  });
});
