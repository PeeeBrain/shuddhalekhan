import type { ElectronAPI } from '../../preload';
import type {
  AppConfig,
  AppInfo,
  McpServerRuntimeStatus,
  PlatformCapabilitiesSnapshot,
  ShortcutBinding,
  ShortcutValidationResponse,
  UpdateStatus,
} from '../../types/ipc';

type Unsubscribe = () => void;

export interface SettingsIpc {
  getConfig: () => Promise<AppConfig>;
  setConfig: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => Promise<void>;
  getAppInfo: () => Promise<AppInfo>;
  getPlatformCapabilities: () => Promise<PlatformCapabilitiesSnapshot>;
  getUpdateStatus: () => Promise<UpdateStatus>;
  checkForUpdates: () => Promise<UpdateStatus>;
  testMcpServer: (serverId: string) => Promise<void>;
  getShortcuts: () => Promise<AppConfig['shortcuts']>;
  validateShortcut: (binding: ShortcutBinding) => Promise<ShortcutValidationResponse>;
  saveShortcut: (binding: ShortcutBinding) => Promise<void>;
  onUpdateStatusChanged: (callback: (status: UpdateStatus) => void) => Unsubscribe | undefined;
  onMcpServerStatus: (callback: (status: McpServerRuntimeStatus) => void) => Unsubscribe | undefined;
}

export function createSettingsIpc(electronAPI: ElectronAPI | undefined): SettingsIpc {
  return {
    getConfig: () => requireElectronApi(electronAPI).invoke('config:get'),
    setConfig: async (key, value) => {
      await electronAPI?.invoke('config:set', key, value);
    },
    getAppInfo: () => requireElectronApi(electronAPI).invoke('app:get-info'),
    getPlatformCapabilities: () => requireElectronApi(electronAPI).invoke('platform:get-capabilities'),
    getUpdateStatus: () => requireElectronApi(electronAPI).invoke('updater:get-status'),
    checkForUpdates: () => requireElectronApi(electronAPI).invoke('updater:check'),
    testMcpServer: async (serverId) => {
      await electronAPI?.invoke('mcp:test-server', serverId);
    },
    getShortcuts: () => requireElectronApi(electronAPI).invoke('shortcuts:get'),
    validateShortcut: async (binding) => requireElectronApi(electronAPI).invoke('shortcuts:validate', binding),
    saveShortcut: async (binding) => { await requireElectronApi(electronAPI).invoke('shortcuts:save', binding); },
    onUpdateStatusChanged: (callback) => electronAPI?.on('updater:status-changed', callback),
    onMcpServerStatus: (callback) => electronAPI?.on('mcp:server-status', callback),
  };
}

function requireElectronApi(electronAPI: ElectronAPI | undefined): ElectronAPI {
  if (!electronAPI) {
    throw new Error('Electron API is unavailable.');
  }
  return electronAPI;
}
