import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import crypto from 'node:crypto';
// @ts-ignore
import wsPkg, { WebSocketServer as WSS, WebSocket as WS } from 'ws';
const WebSocketServer = WSS || wsPkg?.WebSocketServer || wsPkg?.default?.WebSocketServer;
const WebSocket = WS || wsPkg?.WebSocket || wsPkg?.default || wsPkg;

import { config } from '../config.js';
import { createChildLogger } from '../logger.js';
import { callingService } from './calling-service.js';

const logger = createChildLogger('AudioSocketGateway');

export class AudioSocketGateway {
  private wss = new WebSocketServer({ noServer: true });

  public handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const match = url.pathname.match(/^\/api\/calling\/sessions\/([^/]+)\/calls\/([^/]+)\/socket\/?$/);
    if (!match) {
      return false;
    }

    const [, wahaSession, callId] = match;

    // Verify authentication if configured
    if (config.apiKey) {
      const authHeader = req.headers['authorization'];
      const xApiKey = req.headers['x-api-key'];
      const queryKey = url.searchParams.get('x-api-key');

      const isDirectKeyAuthorized =
        (typeof xApiKey === 'string' && xApiKey === config.apiKey) ||
        (typeof authHeader === 'string' && authHeader.replace(/^Bearer\s+/i, '') === config.apiKey) ||
        (queryKey === config.apiKey);

      let isTokenAuthorized = false;
      const tokenParam = url.searchParams.get('token');
      if (tokenParam) {
        try {
          const decoded = Buffer.from(tokenParam, 'base64url').toString('utf-8');
          let uid: string | undefined;
          let sess: string | undefined;
          let cid: string | undefined;
          let expStr: string | undefined;
          let sig: string | undefined;

          if (decoded.startsWith('{')) {
            const parsed = JSON.parse(decoded);
            uid = String(parsed.uid);
            sess = String(parsed.sess);
            cid = String(parsed.cid);
            expStr = String(parsed.exp);
            sig = String(parsed.sig);
          } else {
            const parts = decoded.split(':');
            if (parts.length === 5) {
              [uid, sess, cid, expStr, sig] = parts;
            }
          }

          if (uid && sess && cid && expStr && sig) {
            const exp = parseInt(expStr, 10);
            const now = Math.floor(Date.now() / 1000);
            if (exp > now && sess === wahaSession && cid === callId) {
              const expectedPayload = `${uid}:${sess}:${cid}:${expStr}`;
              const expectedSig = crypto
                .createHmac('sha256', config.apiKey)
                .update(expectedPayload)
                .digest('hex');
              if (
                sig.length === expectedSig.length &&
                crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))
              ) {
                isTokenAuthorized = true;
              }
            }
          }
        } catch (e: any) {
          logger.warn(`Audio WS token verification error: ${e.message}`);
        }
      }

      if (!isDirectKeyAuthorized && !isTokenAuthorized) {
        logger.warn(`Unauthorized audio websocket upgrade attempt for session ${wahaSession}`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return true;
      }
    }

    this.wss.handleUpgrade(req, socket, head, async (browserWs: any) => {
      try {
        const callingSession = await callingService.getOrResolveCallingSession(wahaSession);
        const engineBaseUrl = config.wacallsUrl.replace(/^http/i, 'ws').replace(/\/+$/, '');
        const tokenQuery = config.wacallsToken ? `?token=${encodeURIComponent(config.wacallsToken)}` : '';
        const engineWsUrl = `${engineBaseUrl}/api/sessions/${encodeURIComponent(callingSession.id)}/calls/${encodeURIComponent(callId)}/socket${tokenQuery}`;

        logger.info(`Bridging browser audio WebSocket to Go VoIP engine: ${engineWsUrl}`);
        const engineWs = new WebSocket(engineWsUrl, {
          headers: config.wacallsToken
            ? {
                'X-Internal-Token': config.wacallsToken,
                Authorization: `Bearer ${config.wacallsToken}`,
              }
            : {},
        });

        engineWs.on('open', () => {
          logger.info(`Engine audio WebSocket connected for call ${callId}`);
        });

        browserWs.on('message', (data: any, isBinary: boolean) => {
          if (engineWs.readyState === WebSocket.OPEN) {
            engineWs.send(data, { binary: isBinary });
          }
        });

        engineWs.on('message', (data: any, isBinary: boolean) => {
          if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(data, { binary: isBinary });
          }
        });

        browserWs.on('close', () => {
          logger.info(`Browser audio WebSocket closed for call ${callId}`);
          if (engineWs.readyState === WebSocket.OPEN || engineWs.readyState === WebSocket.CONNECTING) {
            engineWs.close();
          }
        });

        engineWs.on('close', () => {
          logger.info(`Engine audio WebSocket closed for call ${callId}`);
          if (browserWs.readyState === WebSocket.OPEN || browserWs.readyState === WebSocket.CONNECTING) {
            browserWs.close();
          }
        });

        engineWs.on('error', (err: any) => {
          logger.error(`Engine audio WebSocket error for call ${callId}: ${err.message}`);
          browserWs.close();
        });

        browserWs.on('error', (err: any) => {
          logger.error(`Browser audio WebSocket error for call ${callId}: ${err.message}`);
          engineWs.close();
        });
      } catch (err: any) {
        logger.error(`Failed to establish engine audio socket bridge: ${err.message}`);
        browserWs.close(1011, err.message);
      }
    });

    return true;
  }
}

export const audioSocketGateway = new AudioSocketGateway();
