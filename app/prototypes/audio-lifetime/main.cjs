/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, __dirname, Buffer, setTimeout, performance, process */
// PROTOTYPE ONLY — not production runtime code.
const { app, BrowserWindow, dialog, ipcMain, Menu, session } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

let window;
const sinks = new Map();
const smoke = process.argv.includes('--smoke');

function serializeMetrics() {
  return app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    cpuPercent: metric.cpu?.percentCPUUsage ?? null,
    workingSetKb: metric.memory?.workingSetSize ?? null,
    peakWorkingSetKb: metric.memory?.peakWorkingSetSize ?? null,
    privateBytesKb: metric.memory?.privateBytes ?? null,
  }));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'media');
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });

  window = new BrowserWindow({
    width: 1120,
    height: 820,
    show: !smoke,
    backgroundColor: '#111827',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  if (smoke) {
    window.webContents.once('did-finish-load', () => {
      process.stdout.write('audio-lifetime prototype loaded\n');
      app.quit();
    });
  }
  window.loadFile(path.join(__dirname, 'index.html'));
});

ipcMain.handle('prototype:metrics', () => serializeMetrics());

ipcMain.handle('prototype:hide-for', (_event, durationMs) => {
  window.hide();
  setTimeout(() => {
    if (window && !window.isDestroyed()) {
      window.showInactive();
      window.webContents.send('prototype:visible-again');
    }
  }, Math.max(250, Number(durationMs) || 1000));
  return { hiddenAt: performance.now() };
});

ipcMain.handle('prototype:sink-start', (_event, runId) => {
  sinks.set(runId, { hash: crypto.createHash('sha256'), bytes: 0, chunks: 0 });
});

ipcMain.handle('prototype:pcm-chunk', async (_event, runId, bytes, delayMs) => {
  const sink = sinks.get(runId);
  if (!sink) throw new Error(`Unknown sink ${runId}`);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const chunk = Buffer.from(bytes);
  sink.hash.update(chunk);
  sink.bytes += chunk.byteLength;
  sink.chunks += 1;
  return { bytes: sink.bytes, chunks: sink.chunks };
});

ipcMain.handle('prototype:sink-finish', (_event, runId) => {
  const sink = sinks.get(runId);
  if (!sink) throw new Error(`Unknown sink ${runId}`);
  sinks.delete(runId);
  return { hash: sink.hash.digest('hex'), bytes: sink.bytes, chunks: sink.chunks };
});

ipcMain.handle('prototype:save-report', async (_event, report) => {
  const result = await dialog.showSaveDialog(window, {
    title: 'Export audio lifetime prototype report',
    defaultPath: `audio-lifetime-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return null;
  await fs.writeFile(result.filePath, JSON.stringify(report, null, 2), 'utf8');
  return result.filePath;
});

app.on('window-all-closed', () => app.quit());
