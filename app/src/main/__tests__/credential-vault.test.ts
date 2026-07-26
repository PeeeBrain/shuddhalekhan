import { describe, expect, it, mock } from 'bun:test';
import { normalize } from 'path';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';

const storeOptions: Array<{ name?: string; cwd?: string }> = [];

installElectronMock();
mock.module('electron-store', () => ({
  default: class {
    constructor(options: { name?: string; cwd?: string }) {
      storeOptions.push(options);
    }
    get() {
      return {};
    }
    set() {}
  },
}));

describe('CredentialVault', () => {
  it('uses the same stable directory as the main config store', async () => {
    resetElectronMock();
    storeOptions.length = 0;

    await import(`../credential-vault?test=${Date.now()}-stable-store-path`);

    expect(storeOptions[0]).toMatchObject({
      name: 'shuddhalekhan-credentials',
      cwd: normalize('/home/tester/Shuddhalekhan'),
    });
    expect(electronMock.app.getPath).toHaveBeenCalledWith('appData');
  });

  it('encrypts, replaces, and removes an Agent API key without persisting plaintext', async () => {
    const { CredentialVault } = await import('../credential-vault');
    const data = new Map<string, Record<string, string>>();
    const vault = new CredentialVault(
      {
        get: (key: string) => data.get(key),
        set: (key: string, value: Record<string, string>) => data.set(key, value),
      },
      {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`encrypted:${value}`),
        decryptString: (value) => value.toString().replace('encrypted:', ''),
      },
    );

    vault.save('agent-api-key', 'first-secret');
    expect(data.get('credentials')?.['agent-api-key']).not.toContain('first-secret');
    expect(vault.read('agent-api-key')).toBe('first-secret');

    vault.save('agent-api-key', 'replacement-secret');
    expect(vault.read('agent-api-key')).toBe('replacement-secret');

    vault.remove('agent-api-key');
    expect(vault.status('agent-api-key')).toEqual({ available: true, exists: false });
    expect(vault.read('agent-api-key')).toBeNull();
  });

  it('refuses plaintext persistence when secure encryption is unavailable', async () => {
    const { CredentialVault } = await import('../credential-vault');
    const writes: unknown[] = [];
    const vault = new CredentialVault(
      { get: () => ({}), set: (_key: string, value: Record<string, string>) => writes.push(value) },
      {
        isEncryptionAvailable: () => false,
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString(),
      },
    );

    expect(vault.status('agent-api-key')).toEqual({
      available: false,
      exists: false,
      message: 'Secure credential storage is unavailable. Shuddhalekhan will not save credentials in plaintext.',
    });
    expect(() => vault.save('agent-api-key', 'secret')).toThrow('Secure credential storage is unavailable.');
    expect(writes).toEqual([]);
  });

  it('clears an encrypted record that can no longer be decrypted', async () => {
    const { CredentialVault } = await import('../credential-vault');
    const data = new Map<string, Record<string, string>>([
      ['credentials', { 'agent-api-key': Buffer.from('corrupt').toString('base64') }],
    ]);
    const vault = new CredentialVault(
      {
        get: (key: string) => data.get(key),
        set: (key: string, value: Record<string, string>) => data.set(key, value),
      },
      {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value),
        decryptString: () => { throw new Error('cannot decrypt'); },
      },
    );

    expect(vault.read('agent-api-key')).toBeNull();
    expect(vault.status('agent-api-key')).toEqual({ available: true, exists: false });
  });

  it('stores opaque multi-field credentials without inspecting their contents', async () => {
    const { CredentialVault } = await import('../credential-vault');
    const data = new Map<string, Record<string, string>>();
    const vault = new CredentialVault(
      {
        get: (key: string) => data.get(key),
        set: (key: string, value: Record<string, string>) => data.set(key, value),
      },
      {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString(),
      },
    );
    const serviceAccount = '{"type":"service_account","private_key":"not-rendered"}';

    vault.save('google-service-account', serviceAccount);
    expect(vault.read('google-service-account')).toBe(serviceAccount);
  });
});
