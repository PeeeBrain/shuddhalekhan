import { contextBridge, ipcRenderer } from 'electron';
import type {
  MainToRendererChannels,
  RendererToMainInvokeChannels,
  RendererToMainSendChannels,
} from '../types/ipc';

const ipc = {
  invoke: <K extends keyof RendererToMainInvokeChannels>(
    channel: K,
    ...args: Parameters<RendererToMainInvokeChannels[K]>
  ): ReturnType<RendererToMainInvokeChannels[K]> => {
    return ipcRenderer.invoke(channel, ...args) as ReturnType<RendererToMainInvokeChannels[K]>;
  },
  send: <K extends keyof RendererToMainSendChannels>(
    channel: K,
    ...args: Parameters<RendererToMainSendChannels[K]>
  ) => {
    ipcRenderer.send(channel, ...args);
  },
  on: <K extends keyof MainToRendererChannels>(
    channel: K,
    callback: (...args: Parameters<MainToRendererChannels[K]>) => void
  ) => {
    const wrapper = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
      callback(...args as Parameters<MainToRendererChannels[K]>);
    };
    ipcRenderer.on(channel, wrapper);
    return () => {
      ipcRenderer.removeListener(channel, wrapper);
    };
  },
};

contextBridge.exposeInMainWorld('electronAPI', ipc);

export type ElectronAPI = typeof ipc;
