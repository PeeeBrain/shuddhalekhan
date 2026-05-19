import { describe, expect, it } from 'bun:test';
import type { AppConfig } from '../../types/ipc';
import { getSidecarConfigAction } from '../sidecar-config-policy';

const baseConfig: AppConfig = {
  whisperUrl: 'http://localhost:8080/inference',
  selectedDeviceId: null,
  removeFillerWords: true,
  language: 'auto',
  task: 'transcribe',
  dictionary: [],
  agent: {
    enabled: true,
    provider: {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4.1-mini',
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
      thinkingEnabled: true,
    },
    mcpServers: [
      {
        id: 'mail',
        displayName: 'Hosted Mail',
        enabled: true,
        transport: { type: 'http', url: 'https://mail.example.com/mcp' },
        discoveredTools: [],
        toolPolicies: {},
      },
    ],
  },
  shortcuts: {
    dictation: { action: 'dictation', accelerator: 'Control+Meta', triggerMode: 'hold', status: 'unassigned' },
    agent: { action: 'agent', accelerator: 'Alt+Meta', triggerMode: 'hold', status: 'unassigned' },
  },
};

describe('getSidecarConfigAction', () => {
  it('ignores audio-only config changes', () => {
    expect(getSidecarConfigAction(baseConfig, { ...baseConfig, whisperUrl: 'http://new' })).toBe('none');
    expect(getSidecarConfigAction(baseConfig, { ...baseConfig, selectedDeviceId: 'mic-1' })).toBe('none');
    expect(getSidecarConfigAction(baseConfig, { ...baseConfig, removeFillerWords: false })).toBe('none');
  });

  it('stops the sidecar when Agent Mode is disabled', () => {
    expect(getSidecarConfigAction(baseConfig, {
      ...baseConfig,
      agent: { ...baseConfig.agent, enabled: false },
    })).toBe('stop');
  });

  it('starts or updates the sidecar when Agent Mode is enabled and sidecar config changes', () => {
    expect(getSidecarConfigAction({
      ...baseConfig,
      agent: { ...baseConfig.agent, enabled: false },
    }, baseConfig)).toBe('start');

    expect(getSidecarConfigAction(baseConfig, {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        provider: { ...baseConfig.agent.provider, model: 'openai/gpt-5-mini' },
      },
    })).toBe('start');

    expect(getSidecarConfigAction(baseConfig, {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        mcpServers: [
          {
            ...baseConfig.agent.mcpServers[0],
            enabled: false,
          },
        ],
      },
    })).toBe('start');
  });

  it('ignores equivalent sidecar config', () => {
    expect(getSidecarConfigAction(baseConfig, {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        provider: { ...baseConfig.agent.provider },
        mcpServers: [...baseConfig.agent.mcpServers],
      },
    })).toBe('none');
  });
});
