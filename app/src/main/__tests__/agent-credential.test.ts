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
    const config = { agent: { provider: { apiKeyEnvVar: 'OPENROUTER_API_KEY' } } };

    expect(getAgentSidecarApiKey(config as never, vault)).toBeUndefined();
    expect(reads).toBe(0);
  });
});
