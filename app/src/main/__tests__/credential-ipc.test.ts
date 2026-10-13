import { describe, expect, it } from 'bun:test';
import { registerCredentialIpcHandlers } from '../credential-ipc';

describe('credential IPC', () => {
  it('does not disguise a change-notification failure as a vault save failure', () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let saved = false;
    const status = { available: true, exists: true } as const;
    registerCredentialIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
      status: () => status, save: () => { saved = true; return status; }, remove: () => status,
    }, () => { throw new Error('Notification failed.'); });
    expect(() => handlers.get('credential:save')?.({}, 'agent-api-key', 'new-agent-secret')).toThrow('Notification failed.');
    expect(saved).toBe(true);
  });
  it('returns credential status after a save without returning the supplied secret', () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const vault = {
      status: () => ({ available: true, exists: true }) as const,
      save: () => ({ available: true, exists: true }) as const,
      remove: () => ({ available: true, exists: false }) as const,
    };

    const changes: string[] = [];
    registerCredentialIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, vault, kind => changes.push(kind));

    const save = handlers.get('credential:save');
    const result = save?.({}, 'agent-api-key', 'new-agent-secret');

    expect(result).toEqual({ available: true, exists: true });
    expect(JSON.stringify(result)).not.toContain('new-agent-secret');
    expect(changes).toEqual(['agent-api-key']);
    handlers.get('credential:remove')?.({}, 'agent-api-key');
    expect(changes).toEqual(['agent-api-key', 'agent-api-key']);
    expect(handlers.get('credential:get-status')?.({}, 'azure-speech-key')).toEqual({
      available: true,
      exists: true,
    });
  });

  it('rejects malformed Google service-account documents before they reach encrypted storage', () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let saved = false;
    const vault = {
      status: () => ({ available: true, exists: false }) as const,
      save: () => { saved = true; return ({ available: true, exists: true }) as const; },
      remove: () => ({ available: true, exists: false }) as const,
    };
    registerCredentialIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, vault);

    expect(() => handlers.get('credential:save')?.({}, 'google-service-account', '{"private_key":"secret"}')).toThrow();
    expect(saved).toBe(false);
  });

  it('redacts vault save failures from the renderer', () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const vault = {
      status: () => ({ available: true, exists: false }) as const,
      save: () => {
        throw new Error('failed to encrypt new-agent-secret');
      },
      remove: () => ({ available: true, exists: false }) as const,
    };

    registerCredentialIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, vault);

    const save = handlers.get('credential:save');
    const result = save?.({}, 'agent-api-key', 'new-agent-secret');

    expect(result).toEqual({
      available: false,
      exists: false,
      message: 'Unable to save credential securely.',
    });
  });
});
