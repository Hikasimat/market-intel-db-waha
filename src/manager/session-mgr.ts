import fs from 'node:fs/promises';
import path from 'node:path';
import { WhatsappSession } from '../engine/session.js';
import { SessionStatus, type SessionInfo } from '../engine/types.js';
import { createChildLogger } from '../logger.js';
import { config } from '../config.js';

export class SessionManager {
  private sessions = new Map<string, WhatsappSession>();
  private logger = createChildLogger('SessionManager');

  constructor(private sessionsBaseDir: string = config.sessionsDir) {}

  public getSession(name: string): WhatsappSession | undefined {
    return this.sessions.get(name);
  }

  public getWorkingSession(name: string): WhatsappSession {
    const session = this.sessions.get(name);
    if (!session) {
      throw new Error(`Session '${name}' does not exist.`);
    }
    if (session.getStatus() !== SessionStatus.WORKING) {
      throw new Error(`Session '${name}' is not in WORKING state (current: ${session.getStatus()}).`);
    }
    return session;
  }

  public listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.getInfo());
  }

  public async startSession(name: string): Promise<SessionInfo> {
    let session = this.sessions.get(name);
    if (!session) {
      session = new WhatsappSession(name, this.sessionsBaseDir);
      this.sessions.set(name, session);
    }
    await session.start();
    return session.getInfo();
  }

  public async stopSession(name: string): Promise<SessionInfo> {
    const session = this.sessions.get(name);
    if (!session) {
      throw new Error(`Session '${name}' not found.`);
    }
    await session.stop();
    return session.getInfo();
  }

  public async logoutSession(name: string): Promise<SessionInfo> {
    const session = this.sessions.get(name);
    if (!session) {
      throw new Error(`Session '${name}' not found.`);
    }
    await session.logout();
    return session.getInfo();
  }

  public async deleteSession(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (session) {
      await session.stop();
      this.sessions.delete(name);
    }
    const sessionDir = path.join(this.sessionsBaseDir, name);
    try {
      await fs.rm(sessionDir, { recursive: true, force: true });
      this.logger.info(`Session directory deleted: ${sessionDir}`);
    } catch (err: any) {
      this.logger.warn(`Could not delete session directory: ${err.message}`);
    }
  }

  public async restoreExistingSessions(): Promise<void> {
    try {
      await fs.mkdir(this.sessionsBaseDir, { recursive: true });
      const entries = await fs.readdir(this.sessionsBaseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const sessionName = entry.name;
          this.logger.info(`Found existing session folder: ${sessionName}, restoring...`);
          const session = new WhatsappSession(sessionName, this.sessionsBaseDir);
          this.sessions.set(sessionName, session);
          await session.start();
        }
      }
    } catch (err: any) {
      this.logger.error(`Error discovering existing sessions: ${err.message}`);
    }
  }

  public getAllRecentMessages() {
    const all: any[] = [];
    for (const [sessionName, session] of this.sessions.entries()) {
      for (const msg of session.getRecentMessages()) {
        all.push({ ...msg, session: sessionName });
      }
    }
    return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
  }

  public async shutdownAll(): Promise<void> {
    this.logger.info(`Shutting down all ${this.sessions.size} active sessions...`);
    const tasks = Array.from(this.sessions.values()).map((s) => s.stop());
    await Promise.all(tasks);
    this.logger.info('All sessions stopped.');
  }
}

export const sessionManager = new SessionManager();
