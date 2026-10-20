import { Router, type Request, type Response } from 'express';
import { sessionManager } from '../manager/session-mgr.js';
import { SessionStatus } from '../engine/types.js';
import { webhookDispatcher } from '../webhooks/dispatcher.js';

export const authRouter = Router();

// GET /api/:session/auth/qr
authRouter.get('/api/:session/auth/qr', (req: Request, res: Response) => {
  const session = sessionManager.getSession(req.params.session);
  if (!session) {
    return res.status(404).json({
      statusCode: 404,
      message: `Session '${req.params.session}' not found`,
      error: 'Not Found',
    });
  }

  if (session.getStatus() !== SessionStatus.SCAN_QR_CODE) {
    return res.status(400).json({
      statusCode: 400,
      message: `Session '${req.params.session}' is not in SCAN_QR_CODE status (current: ${session.getStatus()})`,
      error: 'Bad Request',
    });
  }

  const { raw, buffer, base64 } = session.getQR();
  if (!raw) {
    return res.status(404).json({
      statusCode: 404,
      message: 'QR code is not yet available. Please wait a moment.',
      error: 'Not Found',
    });
  }

  const wantsImage = req.accepts('image/png') === 'image/png' || req.query.format === 'image';
  if (wantsImage && buffer) {
    res.setHeader('Content-Type', 'image/png');
    return res.send(buffer);
  }

  res.json({
    value: raw,
    qr: raw,
    qrBase64: base64,
  });
});

// POST /api/:session/auth/qr/dispatch
// Force immediate re-dispatch of the current QR code to the configured webhook
authRouter.post('/api/:session/auth/qr/dispatch', (req: Request, res: Response) => {
  const session = sessionManager.getSession(req.params.session);
  if (!session) {
    return res.status(404).json({
      statusCode: 404,
      message: `Session '${req.params.session}' not found`,
      error: 'Not Found',
    });
  }

  const { raw, base64 } = session.getQR();
  if (!raw) {
    return res.status(400).json({
      statusCode: 400,
      message: 'QR code is not yet available or session is already authenticated.',
      error: 'Bad Request',
    });
  }

  webhookDispatcher.dispatch('auth.qr', session.name, {
    session: session.name,
    qr: raw,
    qrBase64: base64,
  });

  return res.json({
    status: 'dispatched',
    session: session.name,
    event: 'auth.qr',
  });
});

// POST /api/:session/auth/request-code
authRouter.post('/api/:session/auth/request-code', async (req: Request, res: Response, next) => {
  try {
    const session = sessionManager.getSession(req.params.session);
    if (!session) {
      return res.status(404).json({
        statusCode: 404,
        message: `Session '${req.params.session}' not found`,
        error: 'Not Found',
      });
    }

    const phoneNumber = req.body?.phoneNumber;
    if (!phoneNumber) {
      return res.status(400).json({
        statusCode: 400,
        message: 'Missing "phoneNumber" in request body.',
        error: 'Bad Request',
      });
    }

    const code = await session.requestPairingCode(phoneNumber);
    res.json({ code });
  } catch (err) {
    next(err);
  }
});
