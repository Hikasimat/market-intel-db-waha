import fs from 'node:fs/promises';
import path from 'node:path';
import AsyncLock from 'async-lock';
import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
} from '@whiskeysockets/baileys';

const lock = new AsyncLock({
  timeout: 5000,
  maxPending: Infinity,
});

export async function useAtomicMultiFileAuthState(folder: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  close: () => Promise<void>;
}> {
  await fs.mkdir(folder, { recursive: true });

  const fixFileName = (file?: string) =>
    file?.replace(/\//g, '__')?.replace(/:/g, '-') || '';

  const writeData = async (data: any, file: string) => {
    const filePath = path.join(folder, fixFileName(file));
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
    const payload = JSON.stringify(data, BufferJSON.replacer);

    await lock.acquire(filePath, async () => {
      await fs.writeFile(tempPath, payload, 'utf-8');
      await fs.rename(tempPath, filePath);
    });
  };

  const readData = async (file: string): Promise<any> => {
    const filePath = path.join(folder, fixFileName(file));
    try {
      const data = await lock.acquire(filePath, async () => {
        return await fs.readFile(filePath, 'utf-8');
      });
      return JSON.parse(data, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const removeData = async (file: string): Promise<void> => {
    const filePath = path.join(folder, fixFileName(file));
    try {
      await lock.acquire(filePath, async () => {
        await fs.unlink(filePath);
      });
    } catch {
      // Ignore if file already removed
    }
  };

  const creds: AuthenticationCreds =
    (await readData('creds.json')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: Record<string, any> = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.create(value);
              }
              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          const dict = data as any;
          for (const category in dict) {
            for (const id in dict[category]) {
              const value = dict[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds.json'),
    close: async () => {},
  };
}
