import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { normalize } from 'path';
import { installElectronMock, resetElectronMock } from '../../test/electron-mock';

const vi = { fn: mock, mock: mock.module, spyOn };

const storeData = new Map<string, unknown>();
const existsSync = vi.fn();
const readFileSync = vi.fn();
const unlinkSync = vi.fn();

class MockStore {
  constructor(options: { defaults: Record<string, unknown> }) {
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
  existsSync,
  readFileSync,
  unlinkSync,
}));

describe('config store', () => {
  beforeEach(() => {
    storeData.clear();
    resetElectronMock();
    existsSync.mockReset();
    readFileSync.mockReset();
    unlinkSync.mockReset();
  });

  it('returns defaults when no legacy config exists', async () => {
    existsSync.mockReturnValue(false);
    const { getConfig } = await import(`../config?test=${Date.now()}-1`);

    expect(getConfig()).toEqual({
      whisperUrl: 'http://localhost:8080/inference',
      selectedDeviceId: null,
      removeFillerWords: true,
      agent: {
        enabled: false,
        provider: {
          baseUrl: '',
          model: '',
          apiKeyEnvVar: '',
        },
      },
    });
  });

  it('sets typed config values', async () => {
    existsSync.mockReturnValue(false);
    const { getConfig, setConfig } = await import(`../config?test=${Date.now()}-2`);

    setConfig('selectedDeviceId', 'usb-mic');
    setConfig('removeFillerWords', false);

    expect(getConfig()).toEqual({
      whisperUrl: 'http://localhost:8080/inference',
      selectedDeviceId: 'usb-mic',
      removeFillerWords: false,
      agent: {
        enabled: false,
        provider: {
          baseUrl: '',
          model: '',
          apiKeyEnvVar: '',
        },
      },
    });
  });

  it('migrates and deletes the legacy config once', async () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({
      whisper_url: 'http://legacy.test/inference',
      selected_device: 'legacy-mic',
      remove_filler_words: false,
    }));

    const { getConfig } = await import(`../config?test=${Date.now()}-3`);

    expect(getConfig()).toEqual({
      whisperUrl: 'http://legacy.test/inference',
      selectedDeviceId: 'legacy-mic',
      removeFillerWords: false,
      agent: {
        enabled: false,
        provider: {
          baseUrl: '',
          model: '',
          apiKeyEnvVar: '',
        },
      },
    });
    expect(readFileSync).toHaveBeenCalledWith(normalize('/home/tester/.speech-2-text/config.json'), 'utf-8');
    expect(unlinkSync).toHaveBeenCalledWith(normalize('/home/tester/.speech-2-text/config.json'));
  });

  it('ignores malformed legacy config and keeps defaults', async () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue('{bad json');

    const { getConfig } = await import(`../config?test=${Date.now()}-4`);

    expect(getConfig()).toEqual({
      whisperUrl: 'http://localhost:8080/inference',
      selectedDeviceId: null,
      removeFillerWords: true,
      agent: {
        enabled: false,
        provider: {
          baseUrl: '',
          model: '',
          apiKeyEnvVar: '',
        },
      },
    });
    expect(unlinkSync).not.toHaveBeenCalled();
  });
});
