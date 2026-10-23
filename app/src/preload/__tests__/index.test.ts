import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';

const vi = { fn: mock, mock: mock.module, spyOn };

installElectronMock();

describe('preload API', () => {
  beforeEach(() => {
    resetElectronMock();
  });

  it('unwraps Electron events and returns an unsubscribe function', async () => {
    await import(`../index?test=${Date.now()}-3`);
    const api = electronMock.contextBridge.exposeInMainWorld.mock.calls[0]?.[1];
    const callback = vi.fn();

    const unsubscribe = api.subscribe('audio:recreate-stream', callback);
    const wrapper = electronMock.ipcRenderer.on.mock.calls[0]?.[1];
    wrapper({ sender: 'ignored' }, 'mic-1');
    unsubscribe();

    expect(electronMock.ipcRenderer.on).toHaveBeenCalledWith('audio:recreate-stream', expect.any(Function));
    expect(callback).toHaveBeenCalledWith('mic-1');
    expect(electronMock.ipcRenderer.removeListener).toHaveBeenCalledWith('audio:recreate-stream', wrapper);
  });
});
