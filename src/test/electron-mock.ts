import { mock } from 'bun:test';

export const electronMock = {
  app: {
    name: 'Shuddhalekhan',
    isPackaged: false,
    whenReady: mock(() => Promise.resolve()),
    on: mock(),
    getPath: mock(() => '/home/tester'),
    getAppPath: mock(() => '/app'),
    getVersion: mock(() => '3.1.0'),
    quit: mock(),
  },
  BrowserWindow: Object.assign(mock(), {
    getAllWindows: mock(() => []),
  }),
  ipcMain: {
    handle: mock(),
    on: mock(),
  },
  clipboard: {
    readText: mock(() => ''),
    writeText: mock(),
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
  electronMock.app.getVersion.mockReturnValue('3.1.0');
  electronMock.app.quit.mockReset();
  electronMock.BrowserWindow.mockReset();
  electronMock.BrowserWindow.getAllWindows.mockReset();
  electronMock.BrowserWindow.getAllWindows.mockReturnValue([]);
  electronMock.ipcMain.handle.mockReset();
  electronMock.ipcMain.on.mockReset();
  electronMock.clipboard.readText.mockReset();
  electronMock.clipboard.readText.mockReturnValue('');
  electronMock.clipboard.writeText.mockReset();
  electronMock.dialog.showErrorBox.mockReset();
  electronMock.dialog.showMessageBox.mockReset();
  electronMock.dialog.showMessageBox.mockResolvedValue({ response: 0 });
  electronMock.session.defaultSession.setPermissionRequestHandler.mockReset();
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
