import { Router, type Request, type Response } from 'express';
import { apiKeyAuth } from '../middleware/auth.js';
import { callingService } from '../calling/calling-service.js';
import { waCallsEvents } from '../calling/event-consumer.js';
import { config } from '../config.js';

export const callingRouter = Router();

// Middleware: check if calling is enabled
function requireCallingEnabled(req: Request, res: Response, next: () => void) {
  if (!config.callingEnabled) {
    res.status(503).json({
      error: 'WhatsApp Calling subsystem is disabled',
      hint: 'Set CALLING_ENABLED=true in environment to activate live voice calling.',
    });
    return;
  }
  next();
}

// Apply API Key auth and feature check to all /api/calling routes
callingRouter.use('/api/calling', apiKeyAuth, requireCallingEnabled);

// GET /api/calling/sessions/:session/status - Get calling session status
callingRouter.get('/api/calling/sessions/:session/status', async (req: Request, res: Response) => {
  try {
    const session = req.params.session;
    const status = await callingService.getSessionStatus(session);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calling/sessions/:session/events - Server-Sent Events stream for live call events
callingRouter.get('/api/calling/sessions/:session/events', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders?.();

  const sessionName = req.params.session;

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const matchesSession = (sName: string) => {
    if (!sName || !sessionName) return true;
    if (sName === sessionName) return true;
    const resolved = waCallsEvents.getSessionName(sName);
    return resolved === sessionName;
  };

  const onRinging = ({ sessionName: sName, payload }: any) => {
    if (matchesSession(sName)) sendEvent('call-ringing', payload);
  };
  const onActive = ({ sessionName: sName, payload }: any) => {
    if (matchesSession(sName)) sendEvent('call-active', payload);
  };
  const onEnded = ({ sessionName: sName, payload }: any) => {
    if (matchesSession(sName)) sendEvent('call-ended', payload);
  };
  const onIncoming = ({ sessionName: sName, payload }: any) => {
    if (matchesSession(sName)) sendEvent('incoming', payload);
  };

  waCallsEvents.on('call-ringing', onRinging);
  waCallsEvents.on('call-active', onActive);
  waCallsEvents.on('call-ended', onEnded);
  waCallsEvents.on('incoming', onIncoming);

  sendEvent('ping', { time: Date.now() });

  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    waCallsEvents.off('call-ringing', onRinging);
    waCallsEvents.off('call-active', onActive);
    waCallsEvents.off('call-ended', onEnded);
    waCallsEvents.off('incoming', onIncoming);
  });
});

// POST /api/calling/sessions/:session/pair - Kept for compatibility. Calling reuses the WAHA
// WhatsApp session (same QR / linked device), so there is nothing separate to pair.
callingRouter.post('/api/calling/sessions/:session/pair', async (req: Request, res: Response) => {
  try {
    const status = await callingService.getSessionStatus(req.params.session);
    res.json({
      status: status.paired ? 'linked' : 'not_connected',
      message:
        'Voice calling reuses the existing WAHA WhatsApp session; no separate QR pairing is needed. ' +
        'If the session is not connected, scan its QR via GET /api/:session/auth/qr.',
      ...status,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calling/sessions/:session/qr - Kept for compatibility; calling has no QR of its own.
callingRouter.get('/api/calling/sessions/:session/qr', (_req: Request, res: Response) => {
  res.status(404).json({
    error: 'Voice calling has no separate QR. It uses the WAHA session QR (GET /api/:session/auth/qr).',
  });
});

// POST /api/calling/sessions/:session/calls - Initiate outgoing call
callingRouter.post('/api/calling/sessions/:session/calls', async (req: Request, res: Response) => {
  try {
    const session = req.params.session;
    const { phone } = req.body || {};
    if (!phone || typeof phone !== 'string' || !phone.trim()) {
      res.status(400).json({ error: 'Phone number is required in request body.' });
      return;
    }
    const clientId = (req.headers['x-client-id'] as string) || req.query.clientId as string | undefined;
    const result = await callingService.startCall(session, phone.trim(), clientId);
    res.json({
      status: 'calling',
      ...result,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calling/sessions/:session/calls/:callId/accept - Accept incoming call
callingRouter.post('/api/calling/sessions/:session/calls/:callId/accept', async (req: Request, res: Response) => {
  try {
    const { session, callId } = req.params;
    if (!callId || callId === 'undefined') {
      res.status(400).json({ error: 'Valid callId is required' });
      return;
    }
    const clientId = (req.headers['x-client-id'] as string) || req.query.clientId as string | undefined;
    const result = await callingService.accept(session, callId, clientId);
    res.json({
      status: 'accepted',
      ...result,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calling/sessions/:session/calls/:callId/reject - Reject incoming call
callingRouter.post('/api/calling/sessions/:session/calls/:callId/reject', async (req: Request, res: Response) => {
  try {
    const { session, callId } = req.params;
    if (!callId || callId === 'undefined') {
      res.status(400).json({ error: 'Valid callId is required' });
      return;
    }
    await callingService.reject(session, callId);
    res.json({ status: 'rejected', callId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calling/sessions/:session/calls/:callId/webrtc - WebRTC SDP exchange
callingRouter.post('/api/calling/sessions/:session/calls/:callId/webrtc', async (req: Request, res: Response) => {
  try {
    const { session, callId } = req.params;
    if (!callId || callId === 'undefined') {
      res.status(400).json({ error: 'Valid callId is required' });
      return;
    }
    const { sdp_offer } = req.body || {};
    if (!sdp_offer || typeof sdp_offer !== 'string') {
      res.status(400).json({ error: 'sdp_offer string is required in request body.' });
      return;
    }
    const result = await callingService.exchangeWebRTC(session, callId, sdp_offer);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/calling/sessions/:session/calls/:callId - End active call
callingRouter.delete('/api/calling/sessions/:session/calls/:callId', async (req: Request, res: Response) => {
  try {
    const { session, callId } = req.params;
    if (!callId || callId === 'undefined') {
      res.status(400).json({ error: 'Valid callId is required' });
      return;
    }
    await callingService.hangup(session, callId);
    res.json({ status: 'ended', callId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calling/sessions/:session/history - Call history
callingRouter.get('/api/calling/sessions/:session/history', async (req: Request, res: Response) => {
  try {
    const session = req.params.session;
    const history = await callingService.getHistory(session);
    res.json({ rows: history });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
