import type { ElectronAPI } from '../../preload';
import type {
  AppConfig,
  AppInfo,
  McpServerRuntimeStatus,
  UpdateStatus,
  AuditRunSummary,
  AuditEventDetail,
  CredentialKind,
  CredentialStatus,
} from '../../types/ipc';

type Unsubscribe = () => void;

export interface SettingsIpc {
  getConfig: () => Promise<AppConfig>;
  setConfig: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => Promise<void>;
  getAppInfo: () => Promise<AppInfo>;
  getUpdateStatus: () => Promise<UpdateStatus>;
  checkForUpdates: () => Promise<UpdateStatus>;
  testMcpServer: (serverId: string) => Promise<void>;
  checkTranscriptionServer: () => Promise<boolean>;
  getShortcutsPaused: () => Promise<boolean>;
  setShortcutsPaused: (paused: boolean) => Promise<boolean>;
  beginShortcutCapture: () => Promise<void>;
  endShortcutCapture: () => Promise<void>;
  onShortcutsPausedChanged: (callback: (paused: boolean) => void) => Unsubscribe | undefined;
  onUpdateStatusChanged: (callback: (status: UpdateStatus) => void) => Unsubscribe | undefined;
  onMcpServerStatus: (callback: (status: McpServerRuntimeStatus) => void) => Unsubscribe | undefined;
  getAuditRuns: () => Promise<AuditRunSummary[]>;
  getAuditRunDetail: (agentRunId: string) => Promise<AuditEventDetail[]>;
  onAuditRunUpdated: (callback: (agentRunId: string) => void) => Unsubscribe | undefined;
  getCredentialStatus: (credential: CredentialKind) => Promise<CredentialStatus>;
  saveCredential: (credential: CredentialKind, value: string) => Promise<CredentialStatus>;
  removeCredential: (credential: CredentialKind) => Promise<CredentialStatus>;
}

export function createSettingsIpc(electronAPI: ElectronAPI | undefined): SettingsIpc {
  return {
    getConfig: () => requireElectronApi(electronAPI).invoke('config:get'),
    setConfig: async (key, value) => {
      await electronAPI?.invoke('config:set', key, value);
    },
    getAppInfo: () => requireElectronApi(electronAPI).invoke('app:get-info'),
    getUpdateStatus: () => requireElectronApi(electronAPI).invoke('updater:get-status'),
    checkForUpdates: () => requireElectronApi(electronAPI).invoke('updater:check'),
    testMcpServer: async (serverId) => {
      await electronAPI?.invoke('mcp:test-server', serverId);
    },
    checkTranscriptionServer: () => requireElectronApi(electronAPI).invoke('transcription:check-server'),
    getShortcutsPaused: () => requireElectronApi(electronAPI).invoke('shortcuts:get-paused'),
    setShortcutsPaused: (paused) => requireElectronApi(electronAPI).invoke('shortcuts:set-paused', paused),
    beginShortcutCapture: async () => {
      await requireElectronApi(electronAPI).invoke('shortcuts:begin-capture');
    },
    endShortcutCapture: async () => {
      await requireElectronApi(electronAPI).invoke('shortcuts:end-capture');
    },
    onShortcutsPausedChanged: (callback) => electronAPI?.on('shortcuts:paused-changed', callback),
    onUpdateStatusChanged: (callback) => electronAPI?.on('updater:status-changed', callback),
    onMcpServerStatus: (callback) => electronAPI?.on('mcp:server-status', callback),
    getAuditRuns: () => requireElectronApi(electronAPI).invoke('audit:get-runs'),
    getAuditRunDetail: (agentRunId) => requireElectronApi(electronAPI).invoke('audit:get-run-detail', agentRunId),
    onAuditRunUpdated: (callback) => electronAPI?.on('audit:run-updated', callback),
    getCredentialStatus: (credential) => requireElectronApi(electronAPI).invoke('credential:get-status', credential),
    saveCredential: (credential, value) => requireElectronApi(electronAPI).invoke('credential:save', credential, value),
    removeCredential: (credential) => requireElectronApi(electronAPI).invoke('credential:remove', credential),
  };
}

function requireElectronApi(electronAPI: ElectronAPI | undefined): ElectronAPI {
  if (!electronAPI) {
    throw new Error('Electron API is unavailable.');
  }
  return electronAPI;
}
