import { describe, expect, it } from 'bun:test';
import type { AppConfig } from '../../types/ipc';
import { getSidecarConfigAction } from '../sidecar-config-policy';

const baseConfig: AppConfig = {
  whisperUrl: 'http://localhost:8080/inference',
  transcription: {
    activeProvider: 'local-whisper-cpp',
    providers: {
      localWhisperCpp: { endpoint: 'http://localhost:8080/inference' },
      openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
      azureSpeech: { endpoint: '', region: '' },
      googleCloudSpeech: { project: '', location: 'global', model: '', credentialSource: 'service-account' },
      nvidiaSpeechNim: { endpoint: '', model: '', auth: 'none', headerName: '', supportsAutomaticLanguageDetection: false, supportsTranslation: false, supportsDictionaryHints: false },
      customOpenAiCompatible: { endpoint: '', model: '', auth: 'none', headerName: '' },
      whisperLiveKit: { baseUrl: 'http://localhost:8000', auth: 'none' },
    },
  },
  selectedDeviceId: null,
  removeFillerWords: true,
  language: 'auto',
  task: 'transcribe',
  dictionary: [],
  pasteStrategy: { default: 'ctrl-v', overrides: {} },
  setupChecklistDismissed: false,
  shortcuts: {
    dictation: { binding: { keyCode: null, modifiers: ['ctrl', 'win'] }, activationMode: 'push-to-talk' },
    agent: { binding: { keyCode: null, modifiers: ['alt', 'win'] }, activationMode: 'push-to-talk' },
  },
  dictation: { mode: 'batch', formatter: null },
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
        transport: { type: 'http', url: 'https://mail.example.com/mcp', redirect: 'error' },
        discoveredTools: [],
        toolPolicies: {},
      },
    ],
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

  it('ignores Dictation runtime settings when deciding sidecar lifecycle', () => {
    expect(getSidecarConfigAction(baseConfig, {
      ...baseConfig,
      dictation: {
        mode: 'corrected',
        formatter: {
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'fmt',
          apiKeyEnvVar: '',
          apiKeySource: 'environment',
          processingConsent: true,
        },
      },
    })).toBe('none');
  });
});
