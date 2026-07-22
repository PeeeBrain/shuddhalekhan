import Store from 'electron-store';
import { safeStorage } from 'electron';
import type { CredentialStatus } from '../types/ipc';

export type { CredentialStatus } from '../types/ipc';

export interface CredentialStore {
  get(key: string): Record<string, string> | undefined;
  set(key: string, value: Record<string, string>): void;
}

export interface SecureStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

const CREDENTIALS_KEY = 'credentials';
const ENCRYPTION_UNAVAILABLE_MESSAGE =
  'Secure credential storage is unavailable. Shuddhalekhan will not save credentials in plaintext.';

export class CredentialVault {
  constructor(
    private readonly store: CredentialStore,
    private readonly storage: SecureStorage,
  ) {}

  status(id: string): CredentialStatus {
    if (!this.storage.isEncryptionAvailable()) {
      return { available: false, exists: false, message: ENCRYPTION_UNAVAILABLE_MESSAGE };
    }

    return { available: true, exists: Boolean(this.records()[id]) };
  }

  save(id: string, value: string): CredentialStatus {
    this.assertEncryptionAvailable();
    const records = this.records();
    records[id] = this.storage.encryptString(value).toString('base64');
    this.store.set(CREDENTIALS_KEY, records);
    return { available: true, exists: true };
  }

  read(id: string): string | null {
    if (!this.storage.isEncryptionAvailable()) return null;

    const encrypted = this.records()[id];
    if (!encrypted) return null;

    try {
      return this.storage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      this.remove(id);
      return null;
    }
  }

  remove(id: string): CredentialStatus {
    const records = this.records();
    delete records[id];
    this.store.set(CREDENTIALS_KEY, records);
    return this.status(id);
  }

  private records(): Record<string, string> {
    return { ...(this.store.get(CREDENTIALS_KEY) ?? {}) };
  }

  private assertEncryptionAvailable(): void {
    if (!this.storage.isEncryptionAvailable()) {
      throw new Error(ENCRYPTION_UNAVAILABLE_MESSAGE);
    }
  }
}

const credentialStore = new Store<Record<string, Record<string, string>>>({
  name: 'shuddhalekhan-credentials',
  defaults: { [CREDENTIALS_KEY]: {} },
});

export const credentialVault = new CredentialVault(credentialStore, safeStorage);
