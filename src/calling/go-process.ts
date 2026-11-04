import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { config } from '../config.js';
import { createChildLogger } from '../logger.js';
import { callingBridge } from './bridge.js';

const logger = createChildLogger('WaCallsEngine');

/**
 * Runs the Go VoIP engine (MLow / SRTP / Pion WebRTC) as a child process of this server,
 * so calling ships inside the same container as WAHA and needs no extra deployment unit.
 * The engine has no WhatsApp login of its own: it is bridged onto the Baileys sessions.
 */
export class WaCallsProcess {
  private child: ChildProcess | null = null;
  private stopping = false;
  private restartDelayMs = 1000;
  private restartTimer: NodeJS.Timeout | null = null;

  public start(): void {
    if (!config.callingEnabled) return;
    if (!config.wacallsEmbedded) {
      logger.info(`Using external calling engine at ${config.wacallsUrl}`);
      return;
    }
    if (!fs.existsSync(config.wacallsBinary)) {
      logger.warn(
        `Calling engine binary not found at ${config.wacallsBinary}; assuming it is running externally at ${config.wacallsUrl}`
      );
      return;
    }
    this.stopping = false;
    this.spawnEngine();
  }

  public stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
    this.child = null;
  }

  private spawnEngine(): void {
    let listen = '127.0.0.1:8080';
    try {
      const u = new URL(config.wacallsUrl);
      listen = `127.0.0.1:${u.port || '8080'}`;
    } catch {
      // keep default
    }

    const args = ['-addr', listen, '-bridge-url', `http://127.0.0.1:${config.port}`];
    logger.info(`Starting calling engine: ${config.wacallsBinary} ${args.join(' ')}`);

    const child = spawn(config.wacallsBinary, args, {
      env: { ...process.env, WACALLS_INTERNAL_TOKEN: config.wacallsToken },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    const pipeLines = (stream: NodeJS.ReadableStream, level: 'info' | 'warn') => {
      let buffer = '';
      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) logger[level](line);
        }
      });
    };
    pipeLines(child.stdout!, 'info');
    pipeLines(child.stderr!, 'info');

    child.on('error', (err) => logger.error(`Calling engine failed to start: ${err.message}`));
    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopping) return;
      logger.warn(`Calling engine exited (code=${code}, signal=${signal}); restarting in ${this.restartDelayMs}ms`);
      this.restartTimer = setTimeout(() => this.spawnEngine(), this.restartDelayMs);
      this.restartDelayMs = Math.min(this.restartDelayMs * 2, 15000);
    });

    this.waitUntilHealthy().then((ok) => {
      if (ok) {
        this.restartDelayMs = 1000;
        // Engine (re)started: re-register every currently connected Baileys session with it.
        callingBridge.reregisterAll().catch((err) => logger.warn(`Re-registering sessions failed: ${err.message}`));
      }
    });
  }

  private async waitUntilHealthy(): Promise<boolean> {
    const url = `${config.wacallsUrl.replace(/\/+$/, '')}/health`;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return true;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    logger.warn('Calling engine did not become healthy in time');
    return false;
  }
}

export const waCallsProcess = new WaCallsProcess();

