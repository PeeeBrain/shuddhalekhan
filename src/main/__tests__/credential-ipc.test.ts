import { describe, expect, it } from 'bun:test';
import { registerCredentialIpcHandlers } from '../credential-ipc';

describe('credential IPC', () => {
  it('returns credential status after a save without returning the supplied secret', () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const vault = {
      status: () => ({ available: true, exists: false }) as const,
      save: () => ({ available: true, exists: true }) as const,
      remove: () => ({ available: true, exists: false }) as const,
    };

    registerCredentialIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, vault);

    const save = handlers.get('credential:save');
    const result = save?.({}, 'agent-api-key', 'new-agent-secret');

    expect(result).toEqual({ available: true, exists: true });
    expect(JSON.stringify(result)).not.toContain('new-agent-secret');
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
