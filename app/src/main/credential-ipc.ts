import type { CredentialKind, CredentialStatus } from '../types/ipc';
import type { CredentialVault } from './credential-vault';
import { parseGoogleServiceAccount } from './google-cloud-speech';

type IpcMainRegistrar = {
  handle(channel: string, listener: (...args: any[]) => unknown): void;
};

const CREDENTIAL_KINDS: CredentialKind[] = [
  'agent-api-key',
  'transcription-api-key',
  'custom-secret-header',
  'google-service-account',
  'openai-api-key',
  'custom-open-ai-compatible-bearer',
  'custom-open-ai-compatible-header',
  'azure-speech-key',
  'nvidia-nim-bearer',
  'nvidia-nim-header',
  'whisper-live-kit-bearer',
  'dictation-formatter-api-key',
];

export function registerCredentialIpcHandlers(
  ipcMain: IpcMainRegistrar,
  vault: Pick<CredentialVault, 'status' | 'save' | 'remove'>,
  onChanged?: (credential: CredentialKind) => void,
): void {
  ipcMain.handle('credential:get-status', (_event, credential: CredentialKind) => {
    return vault.status(requireCredentialKind(credential));
  });

  ipcMain.handle('credential:save', (_event, credential: CredentialKind, value: string): CredentialStatus => {
    if (!value) throw new Error('Credential value is required.');
    const kind = requireCredentialKind(credential);
    if (kind === 'google-service-account') parseGoogleServiceAccount(value);
    try {
      const result = vault.save(kind, value);
      onChanged?.(kind);
      return result;
    } catch {
      return {
        available: false,
        exists: false,
        message: 'Unable to save credential securely.',
      };
    }
  });

  ipcMain.handle('credential:remove', (_event, credential: CredentialKind) => {
    const kind = requireCredentialKind(credential);
    const result = vault.remove(kind);
    onChanged?.(kind);
    return result;
  });
}

function requireCredentialKind(value: CredentialKind): CredentialKind {
  if (CREDENTIAL_KINDS.includes(value)) return value;
  throw new Error('Unsupported credential.');
}
