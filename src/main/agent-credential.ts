import type { AppConfig } from '../types/ipc';

type AgentCredentialVault = {
  read(credential: 'agent-api-key'): string | null;
};

export function getAgentSidecarApiKey(
  config: AppConfig,
  vault: AgentCredentialVault,
): string | undefined {
  if (config.agent.provider.apiKeySource !== 'stored') return undefined;
  return vault.read('agent-api-key') ?? undefined;
}
