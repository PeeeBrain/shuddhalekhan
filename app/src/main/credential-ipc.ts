import type { CredentialKind, CredentialStatus } from '../types/ipc';
import { CREDENTIAL_KINDS } from '../types/ipc';
import { z } from 'zod';
import type { CredentialVault } from './credential-vault';
import { parseGoogleServiceAccount } from './google-cloud-speech';
import type { handle } from './typed-ipc';

export function registerCredentialIpcHandlers(
  ipcMain: { handle: typeof handle },
  vault: Pick<CredentialVault, 'status' | 'save' | 'remove'>,
  onChanged?: (credential: CredentialKind) => void,
): void {
  ipcMain.handle('credential:get-status', (_event, credential) => {
    return vault.status(requireCredentialKind(credential));
  });

  ipcMain.handle('credential:save', (_event, credential, value): CredentialStatus => {
    if (typeof value !== 'string' || !value) throw new Error('Credential value is required.');
    const kind = requireCredentialKind(credential);
    if (kind === 'google-service-account') parseGoogleServiceAccount(value);
    let result: CredentialStatus;
    try {
      result = vault.save(kind, value);
    } catch {
      return {
        available: false,
        exists: false,
        message: 'Unable to save credential securely.',
      };
    }
    onChanged?.(kind);
    return result;
  });

  ipcMain.handle('credential:remove', (_event, credential) => {
    const kind = requireCredentialKind(credential);
    const result = vault.remove(kind);
    onChanged?.(kind);
    return result;
  });
}

function requireCredentialKind(value: unknown): CredentialKind {
  const parsed = z.enum(CREDENTIAL_KINDS).safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error('Unsupported credential.');
}
