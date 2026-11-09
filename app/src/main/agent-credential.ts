import type { AgentProviderConfig, AppConfig } from '../types/ipc';

type AgentCredentialVault = {
  read(credential: 'agent-api-key'): string | null;
};

export function getAgentSidecarApiKey(
  config: AppConfig,
  vault: AgentCredentialVault,
): string | undefined {
  return getStoredAgentApiKey(config.agent.provider, vault);
}

export function getStoredAgentApiKey(provider: AgentProviderConfig, vault: AgentCredentialVault): string | undefined {
  if (provider.kind === 'chatgpt') return undefined;
  if (provider.apiKeySource !== 'stored' || provider.auth === 'none') return undefined;
  return vault.read('agent-api-key') ?? undefined;
}
