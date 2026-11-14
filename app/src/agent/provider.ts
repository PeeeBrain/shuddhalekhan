import { createAgentModel, type AgentModelClient } from '@shuddhalekhan/shared/agent-model';
import type { AgentProviderConfig, AgentProviderDiagnostic } from '../types/ipc';
import { normalizeAgentProvider } from '../shared/agent-provider';
import { resolveAgentProviderKey } from '../shared/agent-provider-validation';

export class AgentProviderConfigurationError extends Error {
  constructor(readonly diagnostic: AgentProviderDiagnostic) { super(diagnostic.message); }
}

/** Resolves the desktop key (stored or environment), then builds the shared model. */
export function createAgentProvider(value: AgentProviderConfig, storedApiKey?: string, sessionId = ''): AgentModelClient & { apiKey?: string } {
  const provider = normalizeAgentProvider(value);
  const { validation, apiKey } = resolveAgentProviderKey(value, storedApiKey, process.env);
  const issue = validation.issues[0];
  if (issue) throw new AgentProviderConfigurationError({
    kind: 'configuration', message: issue.message, action: 'Correct the Agent provider settings and test the model again.',
  });
  return { ...createAgentModel(provider, { apiKey, sessionId }), apiKey };
}
