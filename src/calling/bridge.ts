import {
  encodeSignedDeviceIdentity,
  unpadRandomMax16,
  type BinaryNode,
  type WASocket,
} from '@whiskeysockets/baileys';
import { config } from '../config.js';
import { createChildLogger } from '../logger.js';

const logger = createChildLogger('CallingBridge');

/**
 * Call stanza children the Go engine reacts to.
 *
 * IMPORTANT: 'preaccept' MUST be included.
 *   - After an outgoing offer is sent, the WhatsApp server forwards a <preaccept>
 *     from the recipient's device that confirms the recipient's phone is ringing.
 *   - Without forwarding it, the Go engine never learns the remote device is ringing
 *     and cannot advance beyond OFFER_SENT state.
 */
const FORWARDED_CALL_TAGS = new Set([
  'offer',
  'preaccept',
  'accept',
  'transport',
  'terminate',
  'reject',
  'relaylatency',
  'mute_v2',
]);

type JsonNode = {
  tag: string;
  attrs: Record<string, string>;
  content?: JsonNode[] | string | { $b: string } | null;
};

export function nodeToJson(node: BinaryNode): JsonNode {
  const out: JsonNode = { tag: node.tag, attrs: {} };
  for (const [k, v] of Object.entries(node.attrs || {})) {
    if (v !== undefined && v !== null) out.attrs[k] = String(v);
  }
  const c = node.content as unknown;
  if (Array.isArray(c)) {
    out.content = c.map((child) => nodeToJson(child as BinaryNode));
  } else if (typeof c === 'string') {
    out.content = c;
  } else if (c instanceof Uint8Array) {
    out.content = { $b: Buffer.from(c).toString('base64') };
  }
  return out;
}

export function jsonToNode(j: JsonNode): BinaryNode {
  const node: BinaryNode = { tag: j.tag, attrs: { ...(j.attrs || {}) } };
  const c = j.content;
  if (Array.isArray(c)) {
    node.content = c.map(jsonToNode);
  } else if (typeof c === 'string') {
    node.content = c;
  } else if (c && typeof c === 'object' && '$b' in c) {
    node.content = Buffer.from(c.$b, 'base64');
  }
  return node;
}

function internalHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.wacallsToken) {
    h['X-Internal-Token'] = config.wacallsToken;
    h['Authorization'] = `Bearer ${config.wacallsToken}`;
  }
  return h;
}

/**
 * Bridges each authenticated Baileys socket into the Go VoIP engine.
 * - Registers the session with the engine when the connection opens.
 * - Forwards raw `<call>` stanzas (offer/accept/transport/terminate/reject).
 * - Serves the engine's RPCs (send/query nodes, device lookup, call-key crypto)
 *   using the same Baileys socket, so no second WhatsApp login (QR) is needed.
 */
export class CallingBridge {
  private sockets = new Map<string, WASocket>();
  private listening = new WeakSet<object>();
  private callingSessionIds = new Map<string, string>(); // WAHA session name -> engine session id

  /** Name the engine knows the session by. */
  public static engineName(wahaSession: string): string {
    return `calling_${wahaSession}`;
  }

  public hasSession(wahaSession: string): boolean {
    return this.sockets.has(wahaSession);
  }

  public getEngineSessionId(wahaSession: string): string | undefined {
    return this.callingSessionIds.get(wahaSession);
  }

  public async onConnectionOpen(wahaSession: string, sock: WASocket): Promise<void> {
    if (!config.callingEnabled) return;
    try {
      this.sockets.set(wahaSession, sock);

      // Forward raw call stanzas without interfering with Baileys' own 'call' handling.
      // Also forward <ack class="call"> nodes (server ACK for outgoing offers that carry
      // relay endpoints) and <receipt> nodes that contain a call <accept> child.
      if (!this.listening.has(sock)) {
        this.listening.add(sock);
        (sock.ws as any).on('CB:call', (node: BinaryNode) => this.forwardCallNode(wahaSession, node));
        // Server ACK for call offer — carries relay/SSRC data the engine needs.
        (sock.ws as any).on('CB:ack,,call', (node: BinaryNode) => this.forwardCallAck(wahaSession, node));
        // Receipt events that confirm call acceptance from a linked device or the recipient.
        (sock.ws as any).on('CB:receipt', (node: BinaryNode) => this.forwardReceiptNode(wahaSession, node));
      }

      // The engine may still be starting; retry registration for a short while.
      for (let attempt = 1; attempt <= 6; attempt++) {
        if (this.sockets.get(wahaSession) !== sock) return; // superseded or closed
        if (await this.register(wahaSession, sock)) return;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
      logger.warn(`[${wahaSession}] Calling bridge could not be registered with the engine`);
    } catch (err: any) {
      logger.warn(`[${wahaSession}] Calling bridge error: ${err.message}`);
    }
  }

  /** Re-registers all connected sessions (used after the engine process restarts). */
  public async reregisterAll(): Promise<void> {
    for (const [name, sock] of this.sockets.entries()) {
      await this.register(name, sock);
    }
  }

  private async register(wahaSession: string, sock: WASocket): Promise<boolean> {
    try {
      const creds = sock.authState.creds;
      const me = creds.me;
      if (!me?.id) {
        logger.warn(`[${wahaSession}] Baileys connection open without identity; calling bridge not registered`);
        return false;
      }
      let deviceIdentity = '';
      if (creds.account) {
        deviceIdentity = Buffer.from(encodeSignedDeviceIdentity(creds.account, true)).toString('base64');
      }
      const res = await fetch(`${config.wacallsUrl.replace(/\/+$/, '')}/api/bridge/sessions`, {
        method: 'POST',
        headers: internalHeaders(),
        body: JSON.stringify({
          name: CallingBridge.engineName(wahaSession),
          jid: me.id,
          lid: (me as any).lid || '',
          deviceIdentity,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${await res.text()}`);
      }
      const info = (await res.json()) as { id: string };
      this.callingSessionIds.set(wahaSession, info.id);
      logger.info(`[${wahaSession}] Calling bridge active (engine session ${info.id})`);
      return true;
    } catch (err: any) {
      logger.debug(`[${wahaSession}] Calling bridge registration failed: ${err.message}`);
      return false;
    }
  }

  public async onConnectionClose(wahaSession: string): Promise<void> {
    if (!config.callingEnabled) return;
    this.sockets.delete(wahaSession);
    this.callingSessionIds.delete(wahaSession);
    try {
      await fetch(
        `${config.wacallsUrl.replace(/\/+$/, '')}/api/bridge/sessions/${encodeURIComponent(CallingBridge.engineName(wahaSession))}`,
        { method: 'DELETE', headers: internalHeaders(), signal: AbortSignal.timeout(5000) }
      );
    } catch (err: any) {
      logger.debug(`[${wahaSession}] Calling bridge disconnect notify failed: ${err.message}`);
    }
  }

  private forwardCallNode(wahaSession: string, node: BinaryNode): void {
    try {
      const sid = this.callingSessionIds.get(wahaSession);
      if (!sid) return;
      const children = Array.isArray(node.content) ? (node.content as BinaryNode[]) : [];
      const child = children[0];
      if (!child || !FORWARDED_CALL_TAGS.has(child.tag)) return;
      const from = node.attrs?.from;
      if (!from) return;

      logger.debug(
        `[CALL][${wahaSession}] Forwarding call stanza type=${child.tag} from=${from} ` +
          `call-id=${child.attrs?.['call-id'] || ''} stanza-id=${node.attrs?.id || ''}`
      );

      fetch(`${config.wacallsUrl.replace(/\/+$/, '')}/api/bridge/sessions/${sid}/events`, {
        method: 'POST',
        headers: internalHeaders(),
        body: JSON.stringify({
          type: child.tag,
          from,
          id: node.attrs?.id || '',
          data: nodeToJson(child),
        }),
        signal: AbortSignal.timeout(8000),
      }).catch((err) => logger.warn(`[${wahaSession}] Failed to forward call stanza '${child.tag}': ${err.message}`));
    } catch (err: any) {
      logger.warn(`[${wahaSession}] Error forwarding call stanza: ${err.message}`);
    }
  }

  /**
   * Forwards <ack class="call" type="offer"> nodes from the WhatsApp server.
   * These carry relay endpoint data needed to establish the media path.
   *
   * The WhatsApp server responds to an outgoing call offer with an ACK that
   * contains a <relay> subtree with te2/key/token/auth_token children and
   * a participant list (JIDs for SRTP derivation). Without forwarding this,
   * the Go engine has no relay endpoints and cannot connect media.
   *
   * The node structure:
   *   <ack id="<stanza-id>" class="call" type="offer">
   *     <relay uuid="..." self_pid="..." peer_pid="...">
   *       <key>...</key>
   *       <token id="0">...</token>
   *       <auth_token id="0">...</auth_token>
   *       <te2 relay_id="..." token_id="0" auth_token_id="0" relay_name="..." protocol="0">
   *         <6-byte IPv4+port>
   *       </te2>
   *       ...
   *       <participant jid="..."/>
   *     </relay>
   *   </ack>
   */
  private forwardCallAck(wahaSession: string, node: BinaryNode): void {
    try {
      const sid = this.callingSessionIds.get(wahaSession);
      if (!sid) return;
      const cls = node.attrs?.class;
      const typ = node.attrs?.type;
      if (cls !== 'call') return; // only forward call-class ACKs
      const stanzaId = node.attrs?.id || '';

      logger.info(
        `[CALL][${wahaSession}] Forwarding call ACK class=${cls} type=${typ} stanza-id=${stanzaId}`
      );

      fetch(`${config.wacallsUrl.replace(/\/+$/, '')}/api/bridge/sessions/${sid}/ack`, {
        method: 'POST',
        headers: internalHeaders(),
        body: JSON.stringify({
          type: typ || '',
          id: stanzaId,
          from: node.attrs?.from || '',
          data: nodeToJson(node),
        }),
        signal: AbortSignal.timeout(8000),
      }).catch((err) =>
        logger.warn(`[${wahaSession}] Failed to forward call ACK type=${typ}: ${err.message}`)
      );
    } catch (err: any) {
      logger.warn(`[${wahaSession}] Error forwarding call ACK: ${err.message}`);
    }
  }

  /**
   * Forwards <receipt> nodes that contain a call <accept> or other call-related child.
   * WhatsApp uses receipt stanzas to signal that a linked device accepted a call
   * (e.g. the same account answered on another phone).
   */
  private forwardReceiptNode(wahaSession: string, node: BinaryNode): void {
    try {
      const sid = this.callingSessionIds.get(wahaSession);
      if (!sid) return;
      const children = Array.isArray(node.content) ? (node.content as BinaryNode[]) : [];
      // Only forward receipts that have a call-id attribute or a known call child tag
      const callChild = children.find(
        (c) => c.attrs?.['call-id'] !== undefined || ['offer', 'accept', 'terminate', 'reject', 'preaccept'].includes(c.tag)
      );
      if (!callChild) return;
      const from = node.attrs?.from || node.attrs?.to || '';
      const stanzaId = node.attrs?.id || '';
      logger.info(
        `[CALL][${wahaSession}] Forwarding receipt child=${callChild.tag} from=${from} stanza-id=${stanzaId} call-id=${callChild.attrs?.['call-id'] || ''}`
      );
      fetch(`${config.wacallsUrl.replace(/\/+$/, '')}/api/bridge/sessions/${sid}/events`, {
        method: 'POST',
        headers: internalHeaders(),
        body: JSON.stringify({
          type: `receipt:${callChild.tag}`,
          from,
          id: stanzaId,
          data: nodeToJson(callChild),
        }),
        signal: AbortSignal.timeout(8000),
      }).catch((err) =>
        logger.warn(`[${wahaSession}] Failed to forward receipt/${callChild.tag}: ${err.message}`)
      );
    } catch (err: any) {
      logger.warn(`[${wahaSession}] Error forwarding receipt node: ${err.message}`);
    }
  }

  /** Serves an RPC issued by the Go engine for a given WAHA session. */
  public async handleRpc(engineSessionName: string, method: string, params: any): Promise<unknown> {
    const wahaSession = engineSessionName.startsWith('calling_')
      ? engineSessionName.slice('calling_'.length)
      : engineSessionName;
    const sock = this.sockets.get(wahaSession);
    if (!sock) {
      throw new Error(`WhatsApp session "${wahaSession}" is not connected`);
    }

    switch (method) {
      case 'sendNode': {
        await sock.sendNode(jsonToNode(params.node));
        return {};
      }
      case 'query': {
        const resp = await sock.query(jsonToNode(params.node));
        return { node: resp ? nodeToJson(resp) : null };
      }
      case 'getUSyncDevices': {
        const jids: string[] = params.jids || [];
        const server = jids[0]?.split('@')[1] || 's.whatsapp.net';
        const devices = await (sock as any).getUSyncDevices(jids, false, false);
        const out = (devices as Array<{ user: string; device?: number }>).map((d) =>
          d.device ? `${d.user}:${d.device}@${server}` : `${d.user}@${server}`
        );
        return { jids: out };
      }
      case 'assertSessions': {
        await (sock as any).assertSessions(params.jids || [], !!params.force);
        return {};
      }
      case 'createParticipantNodes': {
        const callKey = Buffer.from(params.callKey, 'base64');
        const { nodes, shouldIncludeDeviceIdentity } = await (sock as any).createParticipantNodes(
          params.devices || [],
          { call: { callKey } },
          params.encAttrs || {}
        );
        return {
          nodes: (nodes as BinaryNode[]).map(nodeToJson),
          includeIdentity: !!shouldIncludeDeviceIdentity,
        };
      }
      case 'decryptCallKey': {
        const ciphertext = Buffer.from(params.ciphertext, 'base64');
        const decrypted = await sock.signalRepository.decryptMessage({
          jid: params.from,
          type: params.type === 'pkmsg' ? 'pkmsg' : 'msg',
          ciphertext,
        });
        const plaintext = unpadRandomMax16(decrypted);
        return { plaintext: Buffer.from(plaintext).toString('base64') };
      }
      case 'resolveLID': {
        const pn = params.pn;
        if (!pn) return { lid: '' };
        try {
          const res = await (sock as any).onWhatsApp(pn);
          const match = res?.find((r: any) => r.exists && r.lid);
          return { lid: match?.lid || '' };
        } catch {
          return { lid: '' };
        }
      }
      default:
        throw new Error(`Unknown bridge RPC method: ${method}`);
    }
  }
}

export const callingBridge = new CallingBridge();
