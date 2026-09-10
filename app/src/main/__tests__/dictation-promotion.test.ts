import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { join, normalize } from 'path';
import { installElectronMock, resetElectronMock } from '../../test/electron-mock';
import {
  getDictationRuntimeError,
  getTranscriptionTransportCapabilities,
  parseMaintainerRuntimeGates,
} from '../../shared/dictation-runtime';
import { validateProviderReadiness } from '../transcription';

/**
 * Promotion fixtures for Live Dictation becoming the out-of-the-box default.
 * Proves the distinction between genuinely new installations (promoted
 * Live/Toggle/WhisperLiveKit identity), every class of pre-existing store
 * (never silently re-modeed), factory resets, and maintainer feature-off
 * switches that block runtime paths without corrupting saved configuration.
 */

const vi = { fn: mock, mock: mock.module };

const storeData = new Map<string, unknown>();
const existsSync = vi.fn();
const readFileSync = vi.fn();
const unlinkSync = vi.fn();
const copyFileSync = vi.fn();
const mkdirSync = vi.fn();

class MockStore {
  constructor(options: { name?: string; cwd?: string; defaults: Record<string, unknown> }) {
    for (const [key, value] of Object.entries(options.defaults)) {
      if (!storeData.has(key)) storeData.set(key, value);
    }
  }

  get(key: string) {
    return storeData.get(key);
  }

  set(key: string, value: unknown) {
    storeData.set(key, value);
  }
}

mock.module('electron-store', () => ({ default: MockStore }));
installElectronMock();
mock.module('fs', () => ({
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
}));

const STABLE_CONFIG_PATH = normalize(
  join('/home/tester', 'Shuddhalekhan', 'shuddhalekhan-config.json'),
);
const LEGACY_CONFIG_PATH = normalize(
  join('/home/tester', '.speech-2-text', 'config.json'),
);

function givenStoreFileOnDisk(exists: boolean): void {
  existsSync.mockImplementation((path: unknown) => exists && path === STABLE_CONFIG_PATH);
}

async function bootConfig(tag: string) {
  return import(`../config?promotion=${tag}-${Date.now()}-${Math.random()}`);
}

describe('Live Dictation promotion', () => {
  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    storeData.clear();
    resetElectronMock();
    existsSync.mockReset();
    readFileSync.mockReset();
    unlinkSync.mockReset();
    copyFileSync.mockReset();
    mkdirSync.mockReset();
  });

  describe('fresh installations', () => {
    it('defaults to Live Dictation, Toggle activation, and WhisperLiveKit', async () => {
      givenStoreFileOnDisk(false);
      const { getConfig } = await bootConfig('fresh');

      expect(getConfig().dictation).toEqual({ mode: 'live', formatter: null });
      expect(getConfig().shortcuts.dictation.activationMode).toBe('toggle');
      expect(getConfig().transcription.activeProvider).toBe('whisper-live-kit');
      // Promotion never touches Agent Mode.
      expect(getConfig().shortcuts.agent.activationMode).toBe('push-to-talk');
      expect(getConfig().agent.enabled).toBe(false);
    });

    it('keeps the promoted identity across a restart once it exists on disk', async () => {
      givenStoreFileOnDisk(false);
      const first = await bootConfig('fresh-restart-a');
      expect(first.getConfig().dictation.mode).toBe('live');

      givenStoreFileOnDisk(true);
      const second = await bootConfig('fresh-restart-b');
      expect(second.getConfig().dictation.mode).toBe('live');
      expect(second.getConfig().shortcuts.dictation.activationMode).toBe('toggle');
      expect(second.getConfig().transcription.activeProvider).toBe('whisper-live-kit');
      // The stored choice is explicit, so the second boot did not rewrite it.
      expect(storeData.get('dictation')).toEqual({ mode: 'live', formatter: null });
    });
  });

  describe('factory reset', () => {
    it('returns to promoted defaults when the store file is deleted', async () => {
      givenStoreFileOnDisk(true);
      storeData.set('dictation', { mode: 'batch', formatter: null });
      const before = await bootConfig('reset-before');
      expect(before.getConfig().dictation.mode).toBe('batch');

      // A factory reset removes the config store entirely.
      storeData.clear();
      givenStoreFileOnDisk(false);
      const after = await bootConfig('reset-after');
      expect(after.getConfig().dictation).toEqual({ mode: 'live', formatter: null });
      expect(after.getConfig().shortcuts.dictation.activationMode).toBe('toggle');
      expect(after.getConfig().transcription.activeProvider).toBe('whisper-live-kit');
    });
  });

  describe('existing stores are preserved', () => {
    it('keeps a legacy v4 store on Batch Dictation with its own shortcuts and provider', async () => {
      givenStoreFileOnDisk(true);
      storeData.set('whisperUrl', 'http://legacy.test/inference');
      storeData.set('transcriptionMigrated', true);
      storeData.set('transcription', {
        activeProvider: 'openai',
        providers: {
          localWhisperCpp: { endpoint: 'http://legacy.test/inference' },
          openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
        },
      });
      storeData.set('shortcutsMigrated', true);
      storeData.set('recordingActivationMode', 'push-to-talk');
      storeData.set('shortcuts', {
        dictation: { binding: { keyCode: 82, modifiers: ['ctrl'] }, activationMode: 'push-to-talk' },
        agent: { binding: { keyCode: null, modifiers: ['alt', 'win'] }, activationMode: 'push-to-talk' },
      });

      const { getConfig } = await bootConfig('v4-upgrade');
      const config = getConfig();

      // No dictation block existed before modes shipped: the user's effective
      // historical behavior was Batch, and it must stay Batch.
      expect(config.dictation).toEqual({ mode: 'batch', formatter: null });
      expect(config.transcription.activeProvider).toBe('openai');
      expect(config.shortcuts.dictation).toEqual({
        binding: { keyCode: 82, modifiers: ['ctrl'] },
        activationMode: 'push-to-talk',
      });
      expect(config.whisperUrl).toBe('http://legacy.test/inference');
    });

    it('treats a legacy-only ~/.speech-2-text install as an upgrade, not a new install', async () => {
      // No stable store file exists, but a legacy config does: this is an
      // upgrade and must keep the historical Batch/push-to-talk/local defaults.
      existsSync.mockImplementation((path: unknown) => path === LEGACY_CONFIG_PATH);
      readFileSync.mockReturnValue(JSON.stringify({
        whisper_url: 'http://legacy-only.test/inference',
        selected_device: 'legacy-mic',
        remove_filler_words: false,
      }));

      const { getConfig } = await bootConfig('legacy-only');
      const config = getConfig();

      expect(config.dictation).toEqual({ mode: 'batch', formatter: null });
      expect(config.transcription.activeProvider).toBe('local-whisper-cpp');
      expect(config.shortcuts.dictation.activationMode).toBe('push-to-talk');
      expect(config.whisperUrl).toBe('http://legacy-only.test/inference');
      expect(config.selectedDeviceId).toBe('legacy-mic');
      expect(config.removeFillerWords).toBe(false);
    });

    it.each([
      ['batch'],
      ['live'],
      ['corrected'],
    ])('preserves an explicit %s selection across restarts', async (...args: unknown[]) => {
      const mode = args[0] as 'batch' | 'live' | 'corrected';
      givenStoreFileOnDisk(true);
      storeData.set('dictation', { mode, formatter: null });
      storeData.set('shortcutsMigrated', true);
      storeData.set('shortcuts', {
        dictation: { binding: { keyCode: null, modifiers: ['ctrl', 'win'] }, activationMode: 'toggle' },
        agent: { binding: { keyCode: null, modifiers: ['alt', 'win'] }, activationMode: 'push-to-talk' },
      });
      storeData.set('transcriptionMigrated', true);
      storeData.set('transcription', {
        activeProvider: 'whisper-live-kit',
        providers: {
          whisperLiveKit: { baseUrl: 'http://localhost:8000', auth: 'none' },
        },
      });

      const first = await bootConfig(`explicit-${mode}-a`);
      expect(first.getConfig().dictation.mode).toBe(mode);

      const second = await bootConfig(`explicit-${mode}-b`);
      expect(second.getConfig().dictation.mode).toBe(mode);
      expect(second.getConfig().shortcuts.dictation.activationMode).toBe('toggle');
      expect(second.getConfig().transcription.activeProvider).toBe('whisper-live-kit');
    });
  });

  describe('missing streaming configuration guides setup instead of flipping modes', () => {
    it('reports actionable WhisperLiveKit guidance while keeping the stored Live mode', async () => {
      givenStoreFileOnDisk(false);
      const first = await bootConfig('guidance-fresh');

      // Simulate an unreachable/unconfigured WhisperLiveKit deployment.
      storeData.set('task', 'translate');
      const config = first.getConfig();
      const errors = validateProviderReadiness('whisper-live-kit', config, { read: () => null });

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join(' ')).toContain('WhisperLiveKit');
      // The failed readiness check never rewrites the persisted dictation mode.
      expect(first.getConfig().dictation.mode).toBe('live');
    });

    it('rejects switching away from the streaming provider while Live mode is selected', async () => {
      givenStoreFileOnDisk(false);
      const { getConfig, setConfig } = await bootConfig('guidance-provider-guard');

      expect(() =>
        setConfig('transcription', {
          ...getConfig().transcription,
          activeProvider: 'local-whisper-cpp',
        }),
      ).toThrow('Live Dictation requires a streaming-capable provider.');
      expect(getConfig().transcription.activeProvider).toBe('whisper-live-kit');
      expect(getConfig().dictation.mode).toBe('live');
    });
  });

  describe('maintainer feature-off switches', () => {
    function withEnv(name: string, value: string | undefined, run: () => void): void {
      const previous = process.env[name];
      try {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
        run();
      } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    }

    it('blocks live insertion at runtime without corrupting the saved configuration', async () => {
      givenStoreFileOnDisk(true);
      storeData.set('dictation', { mode: 'live', formatter: null });
      storeData.set('shortcutsMigrated', true);
      storeData.set('shortcuts', {
        dictation: { binding: { keyCode: null, modifiers: ['ctrl', 'win'] }, activationMode: 'toggle' },
        agent: { binding: { keyCode: null, modifiers: ['alt', 'win'] }, activationMode: 'push-to-talk' },
      });
      storeData.set('transcriptionMigrated', true);
      storeData.set('transcription', {
        activeProvider: 'whisper-live-kit',
        providers: { whisperLiveKit: { baseUrl: 'http://localhost:8000', auth: 'none' } },
      });

      const { getConfig } = await bootConfig('feature-off');
      const savedConfig = getConfig();
      expect(savedConfig.dictation.mode).toBe('live');

      withEnv('SHUDDHALEKHAN_DISABLE_STREAMING', '1', () => {
        const input = {
          mode: savedConfig.dictation.mode,
          activationMode: savedConfig.shortcuts.dictation.activationMode,
          capabilities: getTranscriptionTransportCapabilities(savedConfig.transcription.activeProvider),
          formatter: savedConfig.dictation.formatter,
        };
        expect(getDictationRuntimeError(input, parseMaintainerRuntimeGates(process.env))).toBe(
          'Live Dictation is disabled by a local maintainer switch.',
        );
      });

      // With the switch removed, the same stored configuration runs again.
      expect(
        getDictationRuntimeError(
          {
            mode: savedConfig.dictation.mode,
            activationMode: savedConfig.shortcuts.dictation.activationMode,
            capabilities: getTranscriptionTransportCapabilities(savedConfig.transcription.activeProvider),
            formatter: savedConfig.dictation.formatter,
          },
          parseMaintainerRuntimeGates(process.env),
        ),
      ).toBeNull();
      expect(getConfig()).toEqual(savedConfig);
    });

    it('blocks direct-Unicode insertion independently of the saved combination', () => {
      const validCombination = {
        mode: 'live' as const,
        activationMode: 'toggle' as const,
        capabilities: { batch: true, streaming: true } as const,
        formatter: null,
      };
      withEnv('SHUDDHALEKHAN_DISABLE_DIRECT_UNICODE', '1', () => {
        expect(
          getDictationRuntimeError(validCombination, parseMaintainerRuntimeGates(process.env)),
        ).toBe('Direct-Unicode insertion is disabled by a local maintainer switch.');
      });
      expect(getDictationRuntimeError(validCombination, parseMaintainerRuntimeGates(process.env))).toBeNull();
    });
  });
});
