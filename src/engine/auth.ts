import {
  type AuthenticationState,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

export async function useAtomicMultiFileAuthState(folder: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const { state, saveCreds } = await useMultiFileAuthState(folder);
  return {
    state,
    saveCreds,
    close: async () => {},
  };
}
