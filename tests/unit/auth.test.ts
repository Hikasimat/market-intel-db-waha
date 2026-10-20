import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useAtomicMultiFileAuthState } from '../../src/engine/auth.js';

describe('useAtomicMultiFileAuthState', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `waha-auth-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('should initialize and save credentials atomically', async () => {
    const { state, saveCreds } = await useAtomicMultiFileAuthState(tempDir);
    expect(state.creds).toBeDefined();
    expect(state.creds.noiseKey).toBeDefined();

    // Modify creds property and save
    state.creds.me = { id: '1234567890:1@s.whatsapp.net', name: 'TestUser' } as any;
    await saveCreds();

    // Reload auth state from disk
    const reloaded = await useAtomicMultiFileAuthState(tempDir);
    expect(reloaded.state.creds.me).toBeDefined();
    expect(reloaded.state.creds.me?.id).toBe('1234567890:1@s.whatsapp.net');
  });

  it('should write and read signal keys correctly', async () => {
    const { state } = await useAtomicMultiFileAuthState(tempDir);

    const testPreKey = { keyId: 1, keyPair: { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) } };
    await state.keys.set({
      'pre-key': {
        '1': testPreKey,
      },
    });

    const retrieved = await state.keys.get('pre-key', ['1']);
    expect(retrieved['1']).toBeDefined();
    expect(Buffer.isBuffer(retrieved['1'].keyPair.public)).toBe(true);
    expect(retrieved['1'].keyPair.public[0]).toBe(1);
  });
});
