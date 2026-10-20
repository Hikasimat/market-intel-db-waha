import EventEmitter from 'node:events';
import path from 'node:path';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type proto,
  type WAMessageKey,
  type AnyMessageContent,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { useAtomicMultiFileAuthState } from './auth.js';
import { SessionStatus, type MeInfo, type SessionInfo, type WAMessage } from './types.js';
import { toWAMessage, normalizeJid, parseMessageId } from './normalizer.js';
import { resolveMediaBuffer, downloadAndSaveMedia, type MediaFileInput } from './media.js';
import { createChildLogger } from '../logger.js';
import { config } from '../config.js';
import { webhookDispatcher } from '../webhooks/dispatcher.js';

export function toBaileysJid(chatId: string): string {
  let cleaned = chatId.trim();
  if (cleaned.endsWith('@c.us')) {
    return cleaned.replace('@c.us', '@s.whatsapp.net');
  }
  if (!cleaned.includes('@')) {
    return `${cleaned}@s.whatsapp.net`;
  }
  return cleaned;
}

export class WhatsappSession extends EventEmitter {
  public readonly name: string;
  private readonly sessionFolder: string;
  private logger;
  private status: SessionStatus = SessionStatus.STOPPED;
  private sock: WASocket | null = null;
  private qrString: string | null = null;
  private qrImageBuffer: Buffer | null = null;
  private qrBase64: string | null = null;
  private shouldReconnect = true;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private recentMessages: WAMessage[] = [];
  private profilePicCache: Map<string, { url: string | null; expiresAt: number }> = new Map();

  public getRecentMessages(): WAMessage[] {
    return [...this.recentMessages];
  }

  public addRecentMessage(msg: WAMessage) {
    this.recentMessages.unshift(msg);
    if (this.recentMessages.length > 50) {
      this.recentMessages.pop();
    }
  }

  constructor(name: string, sessionsBaseDir: string = config.sessionsDir) {
    super();
    this.name = name;
    this.sessionFolder = path.join(sessionsBaseDir, name);
    this.logger = createChildLogger(`Session:${name}`);
  }

  public getStatus(): SessionStatus {
    return this.status;
  }

  private setStatus(newStatus: SessionStatus, data?: any) {
    if (this.status !== newStatus) {
      this.logger.info(`Session status changed: ${this.status} -> ${newStatus}`);
      this.status = newStatus;
      this.emit('status.change', { status: newStatus, data });
      webhookDispatcher.dispatch('session.status', this.name, {
        session: this.name,
        status: newStatus,
        me: this.getMe(),
        data,
      });
    }
  }

  public getQR(): { raw: string | null; buffer: Buffer | null; base64: string | null } {
    return {
      raw: this.qrString,
      buffer: this.qrImageBuffer,
      base64: this.qrBase64,
    };
  }

  public getMe(): MeInfo | null {
    if (!this.sock?.user) {
      return null;
    }
    const user = this.sock.user;
    const phone = user.id.split('@')[0].split(':')[0];
    return {
      id: user.id,
      name: user.name || undefined,
      phone,
    };
  }

  public getInfo(): SessionInfo {
    return {
      name: this.name,
      status: this.status,
      me: this.getMe(),
    };
  }

  public getSocket(): WASocket | null {
    return this.sock;
  }

  public async start(): Promise<void> {
    if (this.status === SessionStatus.WORKING || this.status === SessionStatus.STARTING) {
      this.logger.warn(`Session ${this.name} is already ${this.status}`);
      return;
    }

    this.shouldReconnect = true;
    this.setStatus(SessionStatus.STARTING);
    await this.initSocket();
  }

  private async initSocket(): Promise<void> {
    try {
      const { state, saveCreds } = await useAtomicMultiFileAuthState(this.sessionFolder);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] as any }));

      const socketConfig: Parameters<typeof makeWASocket>[0] = {
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger as any),
        },
        logger: this.logger.child({ level: 'silent' }) as any,
        printQRInTerminal: false,
        browser: Browsers.appropriate(config.deviceName),
        defaultQueryTimeoutMs: 60_000,
        keepAliveIntervalMs: 30_000,
        markOnlineOnConnect: true,
      };

      this.sock = makeWASocket(socketConfig);

      // Save credentials whenever updated
      this.sock.ev.on('creds.update', saveCreds);

      // Connection updates (QR, connection open, close)
      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.qrString = qr;
          try {
            this.qrImageBuffer = await QRCode.toBuffer(qr, { width: 300, margin: 2 });
            this.qrBase64 = `data:image/png;base64,${this.qrImageBuffer.toString('base64')}`;
          } catch (err: any) {
            this.logger.error(`Failed to generate QR buffer: ${err.message}`);
          }
          this.setStatus(SessionStatus.SCAN_QR_CODE);
          this.emit('qr', { qr, buffer: this.qrImageBuffer, qrBase64: this.qrBase64 });

          // Webhook-First: Dispatch QR code directly to webhook immediately!
          webhookDispatcher.dispatch('auth.qr', this.name, {
            session: this.name,
            qr,
            qrBase64: this.qrBase64,
          });
        }

        if (connection === 'open') {
          this.reconnectAttempt = 0;
          this.qrString = null;
          this.qrImageBuffer = null;
          this.qrBase64 = null;
          this.setStatus(SessionStatus.WORKING);
          this.logger.info(`Session ${this.name} connected successfully! Phone: ${this.getMe()?.phone}`);
          webhookDispatcher.dispatch('session.connected', this.name, {
            session: this.name,
            me: this.getMe(),
          });
        } else if (connection === 'close') {
          this.qrString = null;
          this.qrImageBuffer = null;
          this.qrBase64 = null;
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;

          this.logger.warn(`Connection closed. Status code: ${statusCode}. Logged out: ${isLoggedOut}`);
          webhookDispatcher.dispatch('session.disconnected', this.name, {
            session: this.name,
            statusCode,
            isLoggedOut,
          });

          if (isLoggedOut) {
            this.shouldReconnect = false;
            this.setStatus(SessionStatus.FAILED, { reason: 'Logged out' });
          } else if (this.shouldReconnect) {
            this.scheduleReconnect();
          } else {
            this.setStatus(SessionStatus.STOPPED);
          }
        }
      });

      // Handle incoming messages
      this.sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const rawMsg of messages) {
          const waMessage = toWAMessage(rawMsg);

          // If message contains media, download and attach URL
          if (waMessage.hasMedia) {
            const savedMedia = await downloadAndSaveMedia(this.name, rawMsg, this.sock);
            if (savedMedia) {
              waMessage.mediaUrl = savedMedia.url;
            }
          }

          // Try to fetch profile picture for the contact
          const targetContactId = waMessage.fromMe ? waMessage.to : (waMessage.participant || waMessage.from);
          if (targetContactId && !targetContactId.endsWith('@g.us') && !targetContactId.endsWith('@broadcast')) {
            try {
              const picUrl = await this.getProfilePictureUrl(targetContactId);
              if (picUrl) {
                waMessage.profilePictureUrl = picUrl;
                if (waMessage.contact) {
                  waMessage.contact.profilePictureUrl = picUrl;
                }
                if (waMessage._data) {
                  waMessage._data.profilePictureUrl = picUrl;
                }
              }
            } catch {
              // Ignore profile picture fetch failure
            }
          }

          this.addRecentMessage(waMessage);
          this.emit('message', waMessage);

          // Dispatch to webhooks
          if (!waMessage.fromMe) {
            webhookDispatcher.dispatch('message', this.name, waMessage);
          }
          webhookDispatcher.dispatch('message.any', this.name, waMessage);
        }
      });

      // Handle message acks
      this.sock.ev.on('messages.update', (updates) => {
        for (const update of updates) {
          const remoteJid = normalizeJid(update.key.remoteJid);
          const ack = update.update.status || 0;
          const payload = {
            id: update.key.id,
            from: remoteJid,
            ack,
          };
          this.emit('message.ack', payload);
          webhookDispatcher.dispatch('message.ack', this.name, payload);
        }
      });

      // Handle message reactions
      this.sock.ev.on('messages.reaction', (reactions) => {
        for (const reaction of reactions) {
          webhookDispatcher.dispatch('message.reaction', this.name, {
            session: this.name,
            ...reaction,
          });
        }
      });

      // Handle presence updates
      this.sock.ev.on('presence.update', (presence) => {
        webhookDispatcher.dispatch('presence.update', this.name, {
          session: this.name,
          ...presence,
        });
      });

      // Handle group participant updates (join, leave, promote, demote)
      this.sock.ev.on('group-participants.update', (update) => {
        const { id, participants, action } = update;
        const normalizedId = normalizeJid(id);
        const normalizedParticipants = participants.map(normalizeJid);

        webhookDispatcher.dispatch('group.v2.participants', this.name, {
          session: this.name,
          id: normalizedId,
          participants: normalizedParticipants,
          action,
        });

        if (action === 'add') {
          webhookDispatcher.dispatch('group.join', this.name, {
            session: this.name,
            id: normalizedId,
            participants: normalizedParticipants,
          });
        } else if (action === 'remove') {
          webhookDispatcher.dispatch('group.leave', this.name, {
            session: this.name,
            id: normalizedId,
            participants: normalizedParticipants,
          });
        }
      });

      // Handle group metadata updates
      this.sock.ev.on('groups.update', (updates) => {
        for (const update of updates) {
          webhookDispatcher.dispatch('group.v2.update', this.name, {
            session: this.name,
            ...update,
          });
        }
      });
    } catch (err: any) {
      this.logger.error(`Failed to initialize socket: ${err.message}`);
      this.setStatus(SessionStatus.FAILED, { error: err.message });
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempt++;
    const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempt - 1), 30000);
    this.logger.info(`Scheduling reconnect attempt #${this.reconnectAttempt} in ${delay}ms...`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        await this.initSocket();
      }
    }, delay);
  }

  public async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.sock) {
      throw new Error('Socket not initialized. Start the session first.');
    }
    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    if (!cleanPhone) {
      throw new Error('Invalid phone number provided.');
    }

    this.logger.info(`Requesting pairing code for phone: ${cleanPhone}...`);
    const code = await this.sock.requestPairingCode(cleanPhone);
    const formatted = `${code.slice(0, 4)}-${code.slice(4)}`;
    this.logger.info(`Pairing code received: ${formatted}`);

    // Webhook-First: Dispatch pairing code directly to webhook!
    webhookDispatcher.dispatch('auth.pairing_code', this.name, {
      session: this.name,
      phoneNumber: cleanPhone,
      code: formatted,
    });

    return formatted;
  }

  public async sendText(
    chatId: string,
    text: string,
    options?: { reply_to?: string | null; mentions?: string[] },
  ): Promise<WAMessage> {
    if (!this.sock) {
      throw new Error(`Session '${this.name}' is not connected.`);
    }

    const jid = toBaileysJid(chatId);
    let quoted: any = undefined;
    if (options?.reply_to) {
      const parsed = parseMessageId(options.reply_to);
      quoted = {
        key: {
          remoteJid: toBaileysJid(parsed.remoteJid || chatId),
          id: parsed.id,
          fromMe: parsed.fromMe,
        },
        message: { conversation: '' },
      };
    }

    const mentions = options?.mentions?.map(toBaileysJid);
    const messageContent: any = { text };
    if (mentions && mentions.length > 0) {
      messageContent.mentions = mentions;
    }

    const sent = await this.sock.sendMessage(jid, messageContent, { quoted });
    if (!sent) {
      throw new Error('Failed to submit message to WhatsApp socket.');
    }

    const waMsg = toWAMessage(sent);
    this.addRecentMessage(waMsg);
    return waMsg;
  }

  public async sendImage(
    chatId: string,
    file: MediaFileInput,
    caption?: string,
  ): Promise<WAMessage> {
    if (!this.sock) {
      throw new Error(`Session '${this.name}' is not connected.`);
    }
    const jid = toBaileysJid(chatId);
    const { buffer, mimetype } = await resolveMediaBuffer(file);
    const content: AnyMessageContent = {
      image: buffer,
      caption: caption || undefined,
      mimetype,
    };
    const sent = await this.sock.sendMessage(jid, content);
    if (!sent) throw new Error('Failed to submit image message.');
    const waMsg = toWAMessage(sent);
    this.addRecentMessage(waMsg);
    return waMsg;
  }

  public async sendFile(
    chatId: string,
    file: MediaFileInput,
    caption?: string,
  ): Promise<WAMessage> {
    if (!this.sock) {
      throw new Error(`Session '${this.name}' is not connected.`);
    }
    const jid = toBaileysJid(chatId);
    const { buffer, mimetype, filename } = await resolveMediaBuffer(file);
    const content: AnyMessageContent = {
      document: buffer,
      mimetype,
      fileName: filename,
      caption: caption || undefined,
    };
    const sent = await this.sock.sendMessage(jid, content);
    if (!sent) throw new Error('Failed to submit document message.');
    const waMsg = toWAMessage(sent);
    this.addRecentMessage(waMsg);
    return waMsg;
  }

  public async sendVoice(
    chatId: string,
    file: MediaFileInput,
  ): Promise<WAMessage> {
    if (!this.sock) {
      throw new Error(`Session '${this.name}' is not connected.`);
    }
    const jid = toBaileysJid(chatId);
    const { buffer, mimetype } = await resolveMediaBuffer(file);
    const content: AnyMessageContent = {
      audio: buffer,
      mimetype: mimetype || 'audio/ogg; codecs=opus',
      ptt: true,
    };
    const sent = await this.sock.sendMessage(jid, content);
    if (!sent) throw new Error('Failed to submit voice message.');
    const waMsg = toWAMessage(sent);
    this.addRecentMessage(waMsg);
    return waMsg;
  }

  public async checkNumberStatus(phone: string): Promise<{ numberExists: boolean; chatId?: string }> {
    if (!this.sock) {
      throw new Error(`Session '${this.name}' is not connected.`);
    }
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const results = await this.sock.onWhatsApp(cleanPhone);
    const result = results?.[0];
    if (!result || !result.exists) {
      return { numberExists: false };
    }
    return {
      numberExists: true,
      chatId: normalizeJid(result.jid),
    };
  }

  public async getProfilePictureUrl(chatId: string): Promise<string | null> {
    if (!this.sock) {
      throw new Error(`Session '${this.name}' is not connected.`);
    }
    const jid = toBaileysJid(chatId);
    const cached = this.profilePicCache.get(jid);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.url;
    }
    try {
      const url = await this.sock.profilePictureUrl(jid, 'image');
      const finalUrl = url || null;
      this.profilePicCache.set(jid, { url: finalUrl, expiresAt: Date.now() + 3600_000 });
      return finalUrl;
    } catch {
      // User has hidden their profile picture or has none
      this.profilePicCache.set(jid, { url: null, expiresAt: Date.now() + 600_000 });
      return null;
    }
  }

  public async getGroups(): Promise<any[]> {
    if (!this.sock) {
      throw new Error(`Session '${this.name}' is not connected.`);
    }
    const groupsMap = await this.sock.groupFetchAllParticipating();
    return Object.values(groupsMap).map((g) => ({
      id: g.id,
      subject: g.subject,
      creation: g.creation,
      owner: normalizeJid(g.owner),
      size: g.size || g.participants?.length,
      participants: g.participants?.map((p) => ({
        id: normalizeJid(p.id),
        admin: p.admin,
      })),
    }));
  }

  public async sendSeen(chatId: string, messageId?: string): Promise<void> {
    if (!this.sock) {
      throw new Error(`Session '${this.name}' is not connected.`);
    }
    const jid = toBaileysJid(chatId);
    if (messageId) {
      const parsed = parseMessageId(messageId);
      const key: WAMessageKey = {
        remoteJid: jid,
        id: parsed.id,
        fromMe: parsed.fromMe,
      };
      await this.sock.readMessages([key]);
    } else {
      await this.sock.chatModify({ markRead: true, lastMessages: [] }, jid);
    }
  }

  public async sendReaction(chatId: string, messageId: string, reaction: string): Promise<void> {
    if (!this.sock) {
      throw new Error(`Session '${this.name}' is not connected.`);
    }
    const jid = toBaileysJid(chatId);
    const parsed = parseMessageId(messageId);
    const key: WAMessageKey = {
      remoteJid: jid,
      id: parsed.id,
      fromMe: parsed.fromMe,
    };
    await this.sock.sendMessage(jid, {
      react: {
        text: reaction,
        key,
      },
    });
  }

  public async stop(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      this.sock.ev.removeAllListeners('connection.update');
      this.sock.ev.removeAllListeners('creds.update');
      this.sock.ev.removeAllListeners('messages.upsert');
      this.sock.end(undefined);
      this.sock = null;
    }
    this.setStatus(SessionStatus.STOPPED);
    this.logger.info(`Session ${this.name} stopped.`);
  }

  public async logout(): Promise<void> {
    this.shouldReconnect = false;
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (err: any) {
        this.logger.warn(`Logout error: ${err.message}`);
      }
    }
    await this.stop();
  }
}
