import type { AgentProviderDiagnostic } from '../types/ipc';

export const providerTestCancelled = {
  kind: 'cancelled', message: 'The model test was cancelled.', action: 'Run Test model when ready.',
} satisfies AgentProviderDiagnostic;
export const providerTestTimedOut = {
  kind: 'timeout', message: 'The model test timed out.', action: 'Check server availability or local model loading, then retry.',
} satisfies AgentProviderDiagnostic;
