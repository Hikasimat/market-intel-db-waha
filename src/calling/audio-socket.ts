import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
// @ts-ignore
import wsPkg from 'ws';
const WebSocketServer = wsPkg.WebSocketServer || wsPkg.Server;
const WebSocket = wsPkg.WebSocket || wsPkg;

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

    // Verify authentication
    if (config.apiKey) {
      const authHeader = req.headers['authorization'];
      const xApiKey = req.headers['x-api-key'];
      const queryKey = url.searchParams.get('x-api-key');

      const isAuthorized =
        (typeof xApiKey === 'string' && xApiKey === config.apiKey) ||
        (typeof authHeader === 'string' && authHeader.replace(/^Bearer\s+/i, '') === config.apiKey) ||
        (queryKey === config.apiKey);

      if (!isAuthorized) {
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
        logger.error(`Failed to bridge audio WebSocket: ${err.message}`);
        browserWs.close(1011, err.message);
      }
    });

    return true;
  }
}

export const audioSocketGateway = new AudioSocketGateway();
