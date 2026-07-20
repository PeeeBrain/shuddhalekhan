import type { CredentialKind, CredentialStatus } from '../types/ipc';
import type { CredentialVault } from './credential-vault';

type IpcMainRegistrar = {
  handle(channel: string, listener: (...args: any[]) => unknown): void;
};

const CREDENTIAL_KINDS: CredentialKind[] = [
  'agent-api-key',
  'transcription-api-key',
  'custom-secret-header',
  'google-service-account',
];

export function registerCredentialIpcHandlers(
  ipcMain: IpcMainRegistrar,
  vault: Pick<CredentialVault, 'status' | 'save' | 'remove'>,
): void {
  ipcMain.handle('credential:get-status', (_event, credential: CredentialKind) => {
    return vault.status(requireCredentialKind(credential));
  });

  ipcMain.handle('credential:save', (_event, credential: CredentialKind, value: string): CredentialStatus => {
    if (!value) throw new Error('Credential value is required.');
    try {
      return vault.save(requireCredentialKind(credential), value);
    } catch {
      return {
        available: false,
        exists: false,
        message: 'Unable to save credential securely.',
      };
    }
  });

  ipcMain.handle('credential:remove', (_event, credential: CredentialKind) => {
    return vault.remove(requireCredentialKind(credential));
  });
}

function requireCredentialKind(value: CredentialKind): CredentialKind {
  if (CREDENTIAL_KINDS.includes(value)) return value;
  throw new Error('Unsupported credential.');
}
