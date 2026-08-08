/* eslint-disable @typescript-eslint/no-require-imports */
/* global require */
// PROTOTYPE ONLY — not production preload code.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('audioPrototype', {
  metrics: () => ipcRenderer.invoke('prototype:metrics'),
  hideFor: (durationMs) => ipcRenderer.invoke('prototype:hide-for', durationMs),
  sinkStart: (runId) => ipcRenderer.invoke('prototype:sink-start', runId),
  sendChunk: (runId, bytes, delayMs) => ipcRenderer.invoke('prototype:pcm-chunk', runId, bytes, delayMs),
  sinkFinish: (runId) => ipcRenderer.invoke('prototype:sink-finish', runId),
  saveReport: (report) => ipcRenderer.invoke('prototype:save-report', report),
  onVisibleAgain: (listener) => ipcRenderer.on('prototype:visible-again', listener),
});
