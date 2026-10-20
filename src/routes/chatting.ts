import { Router, type Request, type Response } from 'express';
import { sessionManager } from '../manager/session-mgr.js';
import type { MessageTextRequest, SendSeenRequest, MessageReactionRequest } from '../engine/types.js';
import type { MediaFileInput } from '../engine/media.js';

export const chattingRouter = Router();

// POST /api/sendText
chattingRouter.post('/api/sendText', async (req: Request, res: Response, next) => {
  try {
    const body: MessageTextRequest = req.body;
    const sessionName = body.session || 'default';
    if (!body.chatId || typeof body.chatId !== 'string') {
      return res.status(400).json({
        statusCode: 400,
        message: 'Missing or invalid "chatId" in request body.',
        error: 'Bad Request',
      });
    }
    if (!body.text || typeof body.text !== 'string') {
      return res.status(400).json({
        statusCode: 400,
        message: 'Missing or invalid "text" in request body.',
        error: 'Bad Request',
      });
    }

    const session = sessionManager.getWorkingSession(sessionName);
    const sent = await session.sendText(body.chatId, body.text, {
      reply_to: body.reply_to,
      mentions: body.mentions,
    });
    res.json(sent);
  } catch (err: any) {
    next(err);
  }
});

// POST /api/sendImage
chattingRouter.post('/api/sendImage', async (req: Request, res: Response, next) => {
  try {
    const { session: sessionName = 'default', chatId, file, caption } = req.body as {
      session?: string;
      chatId: string;
      file: MediaFileInput;
      caption?: string;
    };

    if (!chatId || !file) {
      return res.status(400).json({
        statusCode: 400,
        message: 'Missing "chatId" or "file" in request body.',
        error: 'Bad Request',
      });
    }

    const session = sessionManager.getWorkingSession(sessionName);
    const sent = await session.sendImage(chatId, file, caption);
    res.json(sent);
  } catch (err: any) {
    next(err);
  }
});

// POST /api/sendFile
chattingRouter.post('/api/sendFile', async (req: Request, res: Response, next) => {
  try {
    const { session: sessionName = 'default', chatId, file, caption } = req.body as {
      session?: string;
      chatId: string;
      file: MediaFileInput;
      caption?: string;
    };

    if (!chatId || !file) {
      return res.status(400).json({
        statusCode: 400,
        message: 'Missing "chatId" or "file" in request body.',
        error: 'Bad Request',
      });
    }

    const session = sessionManager.getWorkingSession(sessionName);
    const sent = await session.sendFile(chatId, file, caption);
    res.json(sent);
  } catch (err: any) {
    next(err);
  }
});

// POST /api/sendVoice
chattingRouter.post('/api/sendVoice', async (req: Request, res: Response, next) => {
  try {
    const { session: sessionName = 'default', chatId, file } = req.body as {
      session?: string;
      chatId: string;
      file: MediaFileInput;
    };

    if (!chatId || !file) {
      return res.status(400).json({
        statusCode: 400,
        message: 'Missing "chatId" or "file" in request body.',
        error: 'Bad Request',
      });
    }

    const session = sessionManager.getWorkingSession(sessionName);
    const sent = await session.sendVoice(chatId, file);
    res.json(sent);
  } catch (err: any) {
    next(err);
  }
});

// POST /api/sendSeen
chattingRouter.post('/api/sendSeen', async (req: Request, res: Response, next) => {
  try {
    const body: SendSeenRequest = req.body;
    const sessionName = body.session || 'default';
    if (!body.chatId || typeof body.chatId !== 'string') {
      return res.status(400).json({
        statusCode: 400,
        message: 'Missing or invalid "chatId" in request body.',
        error: 'Bad Request',
      });
    }

    const session = sessionManager.getWorkingSession(sessionName);
    await session.sendSeen(body.chatId, body.messageId);
    res.json({ success: true });
  } catch (err: any) {
    next(err);
  }
});

// POST /api/sendReaction
chattingRouter.post('/api/sendReaction', async (req: Request, res: Response, next) => {
  try {
    const body: MessageReactionRequest = req.body;
    const sessionName = body.session || 'default';
    if (!body.chatId || !body.messageId || body.reaction === undefined) {
      return res.status(400).json({
        statusCode: 400,
        message: 'Missing "chatId", "messageId", or "reaction" in request body.',
        error: 'Bad Request',
      });
    }

    const session = sessionManager.getWorkingSession(sessionName);
    await session.sendReaction(body.chatId, body.messageId, body.reaction);
    res.json({ success: true });
  } catch (err: any) {
    next(err);
  }
});
