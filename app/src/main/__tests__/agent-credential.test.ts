import { describe, expect, it } from 'bun:test';
import { getAgentSidecarApiKey } from '../agent-credential';

describe('Agent credential source selection', () => {
  it('uses a stored key only when the provider explicitly selects that source', () => {
    const vault = { read: (credential: string) => credential === 'agent-api-key' ? 'stored-secret' : null };
    const config = {
      agent: {
        provider: {
          apiKeySource: 'stored' as const,
        },
      },
    };

    expect(getAgentSidecarApiKey(config as never, vault)).toBe('stored-secret');
  });

  it('preserves existing environment-variable configurations without consulting the vault', () => {
    let reads = 0;
    const vault = { read: () => { reads += 1; return 'stored-secret'; } };
    for (const provider of [{ apiKeyEnvVar: 'OPENROUTER_API_KEY' }, { apiKeySource: 'stored', auth: 'none' }]) {
      expect(getAgentSidecarApiKey({ agent: { provider } } as never, vault)).toBeUndefined();
    }
    expect(reads).toBe(0);
  });
});
