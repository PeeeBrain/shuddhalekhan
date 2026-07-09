import { mock } from 'bun:test';

export const electronMock = {
  app: {
    name: 'Shuddhalekhan',
    isPackaged: false,
    whenReady: mock(() => Promise.resolve()),
    on: mock(),
    getPath: mock(() => '/home/tester'),
    getAppPath: mock(() => '/app'),
    getVersion: mock(() => '4.0.0'),
    requestSingleInstanceLock: mock(() => true),
    quit: mock(),
  },
  BrowserWindow: Object.assign(mock(), {
    getAllWindows: mock(() => []),
  }),
  ipcMain: {
    handle: mock(),
    on: mock(),
    off: mock(),
    removeListener: mock(),
  },
  clipboard: {
    availableFormats: mock(() => []),
    readText: mock(() => ''),
    readHTML: mock(() => ''),
    readRTF: mock(() => ''),
    readImage: mock(() => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) })),
    readBookmark: mock(() => ({ title: '', url: '' })),
    writeText: mock(),
    writeHTML: mock(),
    writeRTF: mock(),
    writeImage: mock(),
    writeBookmark: mock(),
    clear: mock(),
  },
  dialog: {
    showErrorBox: mock(),
    showMessageBox: mock(() => Promise.resolve({ response: 0 })),
  },
  session: {
    defaultSession: {
      setPermissionRequestHandler: mock(),
    },
  },
  Notification: Object.assign(mock(() => ({ show: mock() })), {
    isSupported: mock(() => true),
  }),
  shell: {
    openExternal: mock(() => Promise.resolve()),
  },
  screen: {
    getPrimaryDisplay: mock(),
  },
  Tray: mock(),
  Menu: {
    buildFromTemplate: mock((template: unknown) => template),
  },
  nativeImage: {
    createFromPath: mock(),
    createFromDataURL: mock(),
    createFromBuffer: mock(() => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) })),
  },
  contextBridge: {
    exposeInMainWorld: mock(),
  },
  ipcRenderer: {
    invoke: mock(),
    send: mock(),
    on: mock(),
    removeListener: mock(),
  },
};

export function installElectronMock(): void {
  mock.module('electron', () => electronMock);
}

export function resetElectronMock(): void {
  electronMock.app.isPackaged = false;
  electronMock.app.name = 'Shuddhalekhan';
  electronMock.app.whenReady.mockResolvedValue(undefined);
  electronMock.app.on.mockReset();
  electronMock.app.getPath.mockReset();
  electronMock.app.getPath.mockReturnValue('/home/tester');
  electronMock.app.getAppPath.mockReset();
  electronMock.app.getAppPath.mockReturnValue('/app');
  electronMock.app.getVersion.mockReset();
  electronMock.app.getVersion.mockReturnValue('4.0.0');
  electronMock.app.requestSingleInstanceLock.mockReset();
  electronMock.app.requestSingleInstanceLock.mockReturnValue(true);
  electronMock.app.quit.mockReset();
  electronMock.BrowserWindow.mockReset();
  electronMock.BrowserWindow.getAllWindows.mockReset();
  electronMock.BrowserWindow.getAllWindows.mockReturnValue([]);
  electronMock.ipcMain.handle.mockReset();
  electronMock.ipcMain.on.mockReset();
  electronMock.ipcMain.off.mockReset();
  electronMock.ipcMain.removeListener.mockReset();
  electronMock.clipboard.availableFormats.mockReset();
  electronMock.clipboard.availableFormats.mockReturnValue([]);
  electronMock.clipboard.readText.mockReset();
  electronMock.clipboard.readText.mockReturnValue('');
  electronMock.clipboard.readHTML.mockReset();
  electronMock.clipboard.readHTML.mockReturnValue('');
  electronMock.clipboard.readRTF.mockReset();
  electronMock.clipboard.readRTF.mockReturnValue('');
  electronMock.clipboard.readImage.mockReset();
  electronMock.clipboard.readImage.mockReturnValue({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) });
  electronMock.clipboard.readBookmark.mockReset();
  electronMock.clipboard.readBookmark.mockReturnValue({ title: '', url: '' });
  electronMock.clipboard.writeText.mockReset();
  electronMock.clipboard.writeHTML.mockReset();
  electronMock.clipboard.writeRTF.mockReset();
  electronMock.clipboard.writeImage.mockReset();
  electronMock.clipboard.writeBookmark.mockReset();
  electronMock.clipboard.clear.mockReset();
  electronMock.nativeImage.createFromPath.mockReset();
  electronMock.nativeImage.createFromDataURL.mockReset();
  electronMock.nativeImage.createFromBuffer.mockReset();
  electronMock.nativeImage.createFromBuffer.mockReturnValue({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) });
  electronMock.dialog.showErrorBox.mockReset();
  electronMock.dialog.showMessageBox.mockReset();
  electronMock.dialog.showMessageBox.mockResolvedValue({ response: 0 });
  electronMock.session.defaultSession.setPermissionRequestHandler.mockReset();
  electronMock.Notification.mockReset();
  electronMock.Notification.mockImplementation(() => ({ show: mock() }));
  electronMock.Notification.isSupported.mockReset();
  electronMock.Notification.isSupported.mockReturnValue(true);
  electronMock.shell.openExternal.mockReset();
  electronMock.shell.openExternal.mockResolvedValue(undefined);
  electronMock.screen.getPrimaryDisplay.mockReset();
  electronMock.Tray.mockReset();
  electronMock.Menu.buildFromTemplate.mockReset();
  electronMock.Menu.buildFromTemplate.mockImplementation((template: unknown) => template);
  electronMock.nativeImage.createFromPath.mockReset();
  electronMock.nativeImage.createFromDataURL.mockReset();
  electronMock.contextBridge.exposeInMainWorld.mockReset();
  electronMock.ipcRenderer.invoke.mockReset();
  electronMock.ipcRenderer.send.mockReset();
  electronMock.ipcRenderer.on.mockReset();
  electronMock.ipcRenderer.removeListener.mockReset();
}
