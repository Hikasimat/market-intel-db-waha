import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { createChildLogger } from '../logger.js';
import { callingBridge } from '../calling/bridge.js';

const logger = createChildLogger('CallingBridgeRPC');

export const callingBridgeRouter = Router();

function tokenMatches(provided: string | undefined): boolean {
  const expected = config.wacallsToken;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Internal RPC used by the Go VoIP engine to perform WhatsApp operations through the
 * existing Baileys socket. Never exposed to browsers: it requires the shared internal
 * token and refuses requests that came through a reverse proxy.
 */
callingBridgeRouter.post('/internal/bridge/rpc', async (req: Request, res: Response) => {
  if (!config.callingEnabled) {
    res.status(503).json({ error: 'Calling subsystem disabled' });
    return;
  }
  const providedToken = req.header('x-internal-token') || req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!tokenMatches(providedToken)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const { session, method, params } = req.body || {};
  if (typeof session !== 'string' || typeof method !== 'string') {
    res.status(400).json({ error: 'session and method are required' });
    return;
  }
  try {
    const result = await callingBridge.handleRpc(session, method, params || {});
    res.json({ result });
  } catch (err: any) {
    logger.warn(`[${session}] RPC ${method} failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

