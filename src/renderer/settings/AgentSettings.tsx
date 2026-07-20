import { useId, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SectionHeader } from './ui/SectionHeader';
import { ToggleRow, DraftTextRow } from './ui/rows';
import { isLocalProviderUrl, looksLikeRawApiKey } from './settings-model';
import type { SettingsSectionProps } from './settings-section-props';
import type { AppConfig } from '../../types/ipc';

const FIELD_ID_ENABLED = 'agent-enabled';
const FIELD_ID_BASE_URL = 'agent-base-url';
const FIELD_ID_MODEL = 'agent-model';
const FIELD_ID_THINKING = 'agent-thinking';
const FIELD_ID_APIKEY = 'agent-api-key';

export function AgentSettings({ config, persistence }: SettingsSectionProps) {
  const { commit, fieldErrors, clearFieldError } = persistence;
  const agent = config.agent;
  const [pendingDisable, setPendingDisable] = useState(false);

  const apiKeyWarning = looksLikeRawApiKey(agent.provider.apiKeyEnvVar)
    ? 'Enter the environment variable name here, not the API key value. Example: OPENROUTER_API_KEY.'
    : isLocalProviderUrl(agent.provider.baseUrl)
      ? 'Local providers such as Ollama can leave this empty.'
      : undefined;

  const updateAgent = (next: AppConfig['agent']) =>
    commit('agent', next, FIELD_ID_ENABLED);

  const toggleEnabled = (checked: boolean) => {
    if (!checked && agent.enabled) {
      setPendingDisable(true);
    } else {
      updateAgent({ ...agent, enabled: checked });
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Agent"
        description="Configure the voice agent provider and its model."
      />
      <div className="rounded-lg border border-border/60 bg-card px-6">
        <ToggleRow
          title="Enable Agent Mode"
          description="Activates the Alt + Win recording intent. Sidecar execution arrives in later phases."
          checked={agent.enabled}
          tone="agent"
          errorId={useId()}
          error={fieldErrors[FIELD_ID_ENABLED]}
          onChange={toggleEnabled}
        />
        <DraftTextRow
          label="Provider base URL"
          value={agent.provider.baseUrl}
          placeholder="https://openrouter.ai/api/v1"
          errorId={useId()}
          error={fieldErrors[FIELD_ID_BASE_URL]}
          onCommit={(baseUrl) =>
            commit(
              'agent',
              { ...agent, provider: { ...agent.provider, baseUrl } },
              FIELD_ID_BASE_URL,
            )
          }
          clearError={() => clearFieldError(FIELD_ID_BASE_URL)}
        />
        <DraftTextRow
          label="Model"
          value={agent.provider.model}
          placeholder="openai/gpt-4.1-mini"
          errorId={useId()}
          error={fieldErrors[FIELD_ID_MODEL]}
          onCommit={(model) =>
            commit(
              'agent',
              { ...agent, provider: { ...agent.provider, model } },
              FIELD_ID_MODEL,
            )
          }
          clearError={() => clearFieldError(FIELD_ID_MODEL)}
        />
        <ToggleRow
          title="Thinking"
          description="Allows models that support thinking to spend extra reasoning before tool calls."
          checked={agent.provider.thinkingEnabled}
          tone="agent"
          errorId={useId()}
          error={fieldErrors[FIELD_ID_THINKING]}
          onChange={(thinkingEnabled) =>
            commit(
              'agent',
              { ...agent, provider: { ...agent.provider, thinkingEnabled } },
              FIELD_ID_THINKING,
            )
          }
        />
        <DraftTextRow
          label="API key env var name"
          value={agent.provider.apiKeyEnvVar}
          placeholder={
            isLocalProviderUrl(agent.provider.baseUrl)
              ? 'Optional for local providers'
              : 'OPENROUTER_API_KEY'
          }
          warning={apiKeyWarning}
          errorId={useId()}
          error={fieldErrors[FIELD_ID_APIKEY]}
          onCommit={(apiKeyEnvVar) =>
            commit(
              'agent',
              { ...agent, provider: { ...agent.provider, apiKeyEnvVar } },
              FIELD_ID_APIKEY,
            )
          }
          clearError={() => clearFieldError(FIELD_ID_APIKEY)}
        />
      </div>

      <ConfirmDialog
        open={pendingDisable}
        title="Disable Agent Mode?"
        description="Any active agent run will be cancelled and MCP server connections will be closed."
        confirmLabel="Disable"
        onConfirm={() => {
          updateAgent({ ...agent, enabled: false });
          setPendingDisable(false);
        }}
        onCancel={() => setPendingDisable(false)}
      />
    </div>
  );
}