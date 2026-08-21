import type { ElectronAPI } from '../../preload';
import type {
  AppConfig,
  AppInfo,
  McpStatusSnapshot,
  UpdateStatus,
  VersionReleaseNotes,
  AuditRunSummary,
  AuditEventDetail,
  CredentialKind,
  CredentialStatus,
  TranscriptionReadiness,
} from '../../types/ipc';

type Unsubscribe = () => void;

export interface SettingsIpc {
  getConfig: () => Promise<AppConfig>;
  setConfig: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => Promise<void>;
  getAppInfo: () => Promise<AppInfo>;
  getReleaseNotes: () => Promise<VersionReleaseNotes | null>;
  getUpdateStatus: () => Promise<UpdateStatus>;
  checkForUpdates: () => Promise<UpdateStatus>;
  testMcpServer: (serverId: string) => Promise<void>;
  getMcpStatusSnapshot: () => Promise<McpStatusSnapshot>;
  checkTranscriptionServer: () => Promise<boolean>;
  checkTranscriptionReadiness: () => Promise<TranscriptionReadiness>;
  onTranscriptionReadinessChanged: (callback: (readiness: TranscriptionReadiness) => void) => Unsubscribe | undefined;
  getShortcutsPaused: () => Promise<boolean>;
  setShortcutsPaused: (paused: boolean) => Promise<boolean>;
  beginShortcutCapture: () => Promise<void>;
  endShortcutCapture: () => Promise<void>;
  onShortcutsPausedChanged: (callback: (paused: boolean) => void) => Unsubscribe | undefined;
  onUpdateStatusChanged: (callback: (status: UpdateStatus) => void) => Unsubscribe | undefined;
  onNavigateRequested: (callback: (section: 'about') => void) => Unsubscribe | undefined;
  onMcpStatusSnapshot: (callback: (snapshot: McpStatusSnapshot) => void) => Unsubscribe | undefined;
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
    getReleaseNotes: () => requireElectronApi(electronAPI).invoke('app:get-release-notes'),
    getUpdateStatus: () => requireElectronApi(electronAPI).invoke('updater:get-status'),
    checkForUpdates: () => requireElectronApi(electronAPI).invoke('updater:check'),
    testMcpServer: async (serverId) => {
      await electronAPI?.invoke('mcp:test-server', serverId);
    },
    getMcpStatusSnapshot: () => requireElectronApi(electronAPI).invoke('mcp:get-status-snapshot'),
    checkTranscriptionServer: () => requireElectronApi(electronAPI).invoke('transcription:check-server'),
    checkTranscriptionReadiness: () => requireElectronApi(electronAPI).invoke('transcription:check-readiness'),
    getShortcutsPaused: () => requireElectronApi(electronAPI).invoke('shortcuts:get-paused'),
    setShortcutsPaused: (paused) => requireElectronApi(electronAPI).invoke('shortcuts:set-paused', paused),
    beginShortcutCapture: async () => {
      await requireElectronApi(electronAPI).invoke('shortcuts:begin-capture');
    },
    endShortcutCapture: async () => {
      await requireElectronApi(electronAPI).invoke('shortcuts:end-capture');
    },
    onShortcutsPausedChanged: (callback) => electronAPI?.subscribe('shortcuts:paused-changed', callback),
    onUpdateStatusChanged: (callback) => electronAPI?.subscribe('updater:status-changed', callback),
    onNavigateRequested: (callback) => electronAPI?.subscribe('settings:navigate', callback),
    onMcpStatusSnapshot: (callback) => electronAPI?.subscribe('mcp:status-snapshot', callback),
    onTranscriptionReadinessChanged: (callback) => electronAPI?.subscribe('transcription:readiness-changed', callback),
    getAuditRuns: () => requireElectronApi(electronAPI).invoke('audit:get-runs'),
    getAuditRunDetail: (agentRunId) => requireElectronApi(electronAPI).invoke('audit:get-run-detail', agentRunId),
    onAuditRunUpdated: (callback) => electronAPI?.subscribe('audit:run-updated', callback),
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
