import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';

const vi = { fn: mock, mock: mock.module, spyOn };

installElectronMock();

describe('preload API', () => {
  beforeEach(() => {
    resetElectronMock();
  });

  it('exposes a typed electronAPI facade', async () => {
    await import(`../index?test=${Date.now()}-1`);

    expect(electronMock.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('electronAPI', {
      invoke: expect.any(Function),
      send: expect.any(Function),
      on: expect.any(Function),
    });
  });

  it('forwards invoke and send calls to ipcRenderer', async () => {
    electronMock.ipcRenderer.invoke.mockResolvedValue({
      whisperUrl: 'x',
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
    await import(`../index?test=${Date.now()}-2`);
    const api = electronMock.contextBridge.exposeInMainWorld.mock.calls[0]?.[1];

    await expect(api.invoke('config:get')).resolves.toEqual({
      whisperUrl: 'x',
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
    api.send('audio-duration-changed', 4);

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith('config:get');
    expect(electronMock.ipcRenderer.send).toHaveBeenCalledWith('audio-duration-changed', 4);
  });

  it('unwraps Electron events and returns an unsubscribe function', async () => {
    await import(`../index?test=${Date.now()}-3`);
    const api = electronMock.contextBridge.exposeInMainWorld.mock.calls[0]?.[1];
    const callback = vi.fn();

    const unsubscribe = api.on('audio:select-device', callback);
    const wrapper = electronMock.ipcRenderer.on.mock.calls[0]?.[1];
    wrapper({ sender: 'ignored' }, 'mic-1');
    unsubscribe();

    expect(electronMock.ipcRenderer.on).toHaveBeenCalledWith('audio:select-device', expect.any(Function));
    expect(callback).toHaveBeenCalledWith('mic-1');
    expect(electronMock.ipcRenderer.removeListener).toHaveBeenCalledWith('audio:select-device', wrapper);
  });
});
