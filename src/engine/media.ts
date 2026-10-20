import fs from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import mime from 'mime-types';
import { downloadMediaMessage, type proto, type WASocket } from '@whiskeysockets/baileys';
import { config } from '../config.js';
import { createChildLogger } from '../logger.js';

const logger = createChildLogger('Media');

export interface MediaFileInput {
  url?: string;
  data?: string; // base64
  mimetype?: string;
  filename?: string;
}

export async function resolveMediaBuffer(file: MediaFileInput): Promise<{
  buffer: Buffer;
  mimetype: string;
  filename: string;
}> {
  let buffer: Buffer;
  let mimetype = file.mimetype || 'application/octet-stream';
  let filename = file.filename || 'file';

  if (file.data) {
    buffer = Buffer.from(file.data, 'base64');
  } else if (file.url) {
    const res = await axios.get(file.url, { responseType: 'arraybuffer', timeout: 30000 });
    buffer = Buffer.from(res.data);
    const ct = res.headers['content-type'];
    if (!file.mimetype && typeof ct === 'string') {
      mimetype = ct.split(';')[0];
    }
  } else {
    throw new Error('Either "file.url" or "file.data" must be provided.');
  }

  // Ensure extension in filename
  if (!path.extname(filename)) {
    const ext = mime.extension(mimetype);
    if (ext) {
      filename = `${filename}.${ext}`;
    }
  }

  return { buffer, mimetype, filename };
}

export async function downloadAndSaveMedia(
  sessionName: string,
  msg: proto.IWebMessageInfo,
  sock?: WASocket | null,
): Promise<{ url: string; mimetype: string; filename: string } | null> {
  try {
    const messageContent = msg.message;
    if (!messageContent) return null;

    const mediaMsg =
      messageContent.imageMessage ||
      messageContent.videoMessage ||
      messageContent.audioMessage ||
      messageContent.documentMessage ||
      messageContent.stickerMessage;

    if (!mediaMsg) return null;

    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: logger as any,
        reuploadRequest: sock?.updateMediaMessage as any,
      },
    );

    const mimetype = mediaMsg.mimetype || 'application/octet-stream';
    const ext = mime.extension(mimetype) || 'bin';
    const filename = `${msg.key.id || Date.now()}.${ext}`;

    const sessionMediaDir = path.join(config.mediaDir, sessionName);
    await fs.mkdir(sessionMediaDir, { recursive: true });

    const filePath = path.join(sessionMediaDir, filename);
    await fs.writeFile(filePath, buffer);

    const mediaUrl = `/api/files/${sessionName}/${filename}`;
    logger.debug(`Saved media file to ${filePath} (${buffer.length} bytes)`);

    return { url: mediaUrl, mimetype, filename };
  } catch (err: any) {
    logger.error(`Failed to download and save media: ${err.message}`);
    return null;
  }
}
