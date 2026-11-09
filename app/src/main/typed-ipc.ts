import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { RendererToMainInvokeChannels } from '../types/ipc';

export function handle<K extends keyof RendererToMainInvokeChannels>(
  channel: K,
  listener: (event: IpcMainInvokeEvent, ...args: Parameters<RendererToMainInvokeChannels[K]>) =>
    Awaited<ReturnType<RendererToMainInvokeChannels[K]>> | ReturnType<RendererToMainInvokeChannels[K]>,
): void {
  ipcMain.handle(channel, listener);
}
