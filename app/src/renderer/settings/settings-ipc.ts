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
  ManagedLocalModelSnapshot,
  ManagedLocalModelState,
  ManagedLocalTarget,
  ManagedLocalDeleteTarget,
  AgentProviderConfig,
  AgentProviderValidation,
  AgentProviderTestResult,
  ChatGptAccountStatus,
  ChatGptModel,
  TranscriptionSettingsPatch,
} from '../../types/ipc';
import type {
  AgentMemorySnapshot,
  AgentSkillDocument,
  AgentSkillImport,
  AgentSkillSummary,
} from '../../shared/agent-context';

type Unsubscribe = () => void;

export interface SettingsIpc {
  getConfig: () => Promise<AppConfig>;
  setConfig: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => Promise<void>;
  /** All-or-nothing transcription transition; main normalizes and returns the saved config. */
  patchTranscriptionConfig: (patch: TranscriptionSettingsPatch) => Promise<AppConfig>;
  getAppInfo: () => Promise<AppInfo>;
  getReleaseNotes: () => Promise<VersionReleaseNotes | null>;
  getUpdateStatus: () => Promise<UpdateStatus>;
  checkForUpdates: () => Promise<UpdateStatus>;
  testMcpServer: (serverId: string) => Promise<void>;
  getMcpStatusSnapshot: () => Promise<McpStatusSnapshot>;
  checkTranscriptionServer: () => Promise<boolean>;
  checkTranscriptionReadiness: () => Promise<TranscriptionReadiness>;
  onTranscriptionReadinessChanged: (callback: (readiness: TranscriptionReadiness) => void) => Unsubscribe | undefined;
  getManagedLocalModel: () => Promise<ManagedLocalModelSnapshot>;
  /** Omit `target` for the selected model's primary install (Auto means CPU). */
  installManagedLocalModel: (target?: ManagedLocalTarget) => Promise<ManagedLocalModelSnapshot>;
  deleteManagedLocalModel: (target?: ManagedLocalDeleteTarget) => Promise<ManagedLocalModelSnapshot>;
  onManagedLocalModelStateChanged: (callback: (state: ManagedLocalModelState) => void) => Unsubscribe | undefined;
  onOnboardingCompleted: (callback: () => void) => Unsubscribe | undefined;
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
  onCredentialChanged: (callback: (credential: CredentialKind) => void) => Unsubscribe | undefined;
  getCredentialStatus: (credential: CredentialKind) => Promise<CredentialStatus>;
  saveCredential: (credential: CredentialKind, value: string) => Promise<CredentialStatus>;
  removeCredential: (credential: CredentialKind) => Promise<CredentialStatus>;
  validateAgentProvider: (provider: AgentProviderConfig) => Promise<AgentProviderValidation>;
  testAgentProvider: (provider: AgentProviderConfig) => Promise<AgentProviderTestResult>;
  cancelAgentProviderTest: () => Promise<void>;
  onAgentProviderInvalidated: (callback: () => void) => Unsubscribe | undefined;
  getChatGptStatus: () => Promise<ChatGptAccountStatus>;
  signInChatGpt: () => Promise<ChatGptAccountStatus>;
  signOutChatGpt: () => Promise<ChatGptAccountStatus>;
  listChatGptModels: () => Promise<ChatGptModel[]>;
  onChatGptChanged: (callback: (status: ChatGptAccountStatus) => void) => Unsubscribe | undefined;
  listSkills: () => Promise<AgentSkillSummary[]>;
  readSkill: (name: string) => Promise<AgentSkillDocument>;
  saveSkill: (document: AgentSkillDocument & { create: boolean }) => Promise<AgentSkillSummary[]>;
  selectSkillImport: () => Promise<AgentSkillImport | null>;
  importSkill: (token: string) => Promise<AgentSkillSummary[]>;
  removeSkill: (name: string) => Promise<AgentSkillSummary[]>;
  openSkillsFolder: () => Promise<void>;
  getMemory: () => Promise<AgentMemorySnapshot>;
  editMemoryFact: (revision: string, id: string, text: string) => Promise<AgentMemorySnapshot>;
  removeMemoryFact: (revision: string, id: string) => Promise<AgentMemorySnapshot>;
  clearMemory: (revision: string) => Promise<AgentMemorySnapshot>;
  onMemoryChanged: (callback: (snapshot: AgentMemorySnapshot) => void) => Unsubscribe | undefined;
}

export function createSettingsIpc(electronAPI: ElectronAPI | undefined): SettingsIpc {
  return {
    getConfig: () => requireElectronApi(electronAPI).invoke('config:get'),
    setConfig: async (key, value) => {
      await electronAPI?.invoke('config:set', key, value);
    },
    patchTranscriptionConfig: (patch) => requireElectronApi(electronAPI).invoke('config:patch-transcription', patch),
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
    getManagedLocalModel: () => requireElectronApi(electronAPI).invoke('managed-local:get-model'),
    installManagedLocalModel: (target) => requireElectronApi(electronAPI).invoke('managed-local:install-model', target),
    deleteManagedLocalModel: (target) => requireElectronApi(electronAPI).invoke('managed-local:delete-model', target),
    onManagedLocalModelStateChanged: (callback) => electronAPI?.subscribe('managed-local:model-state-changed', callback),
    onOnboardingCompleted: (callback) => electronAPI?.subscribe('onboarding:completed', callback),
    getAuditRuns: () => requireElectronApi(electronAPI).invoke('audit:get-runs'),
    getAuditRunDetail: (agentRunId) => requireElectronApi(electronAPI).invoke('audit:get-run-detail', agentRunId),
    onAuditRunUpdated: (callback) => electronAPI?.subscribe('audit:run-updated', callback),
    onCredentialChanged: (callback) => electronAPI?.subscribe('credential:changed', callback),
    getCredentialStatus: (credential) => requireElectronApi(electronAPI).invoke('credential:get-status', credential),
    saveCredential: (credential, value) => requireElectronApi(electronAPI).invoke('credential:save', credential, value),
    removeCredential: (credential) => requireElectronApi(electronAPI).invoke('credential:remove', credential),
    validateAgentProvider: (provider) => requireElectronApi(electronAPI).invoke('agent:validate-provider', provider),
    testAgentProvider: (provider) => requireElectronApi(electronAPI).invoke('agent:test-provider', provider),
    cancelAgentProviderTest: async () => {
      await electronAPI?.invoke('agent:cancel-provider-test');
    },
    onAgentProviderInvalidated: (callback) => electronAPI?.subscribe('agent:provider-invalidated', callback),
    getChatGptStatus: () => requireElectronApi(electronAPI).invoke('chatgpt:get-status'),
    signInChatGpt: () => requireElectronApi(electronAPI).invoke('chatgpt:sign-in'),
    signOutChatGpt: () => requireElectronApi(electronAPI).invoke('chatgpt:sign-out'),
    listChatGptModels: () => requireElectronApi(electronAPI).invoke('chatgpt:list-models'),
    onChatGptChanged: (callback) => electronAPI?.subscribe('chatgpt:changed', callback),
    listSkills: () => requireElectronApi(electronAPI).invoke('skills:list'),
    readSkill: (name) => requireElectronApi(electronAPI).invoke('skills:read', name),
    saveSkill: (document) => requireElectronApi(electronAPI).invoke('skills:save', document),
    selectSkillImport: () => requireElectronApi(electronAPI).invoke('skills:select-import'),
    importSkill: (token) => requireElectronApi(electronAPI).invoke('skills:import', token),
    removeSkill: (name) => requireElectronApi(electronAPI).invoke('skills:remove', name),
    openSkillsFolder: () => requireElectronApi(electronAPI).invoke('skills:open-folder'),
    getMemory: () => requireElectronApi(electronAPI).invoke('memory:get'),
    editMemoryFact: (revision, id, text) => requireElectronApi(electronAPI).invoke('memory:edit', revision, id, text),
    removeMemoryFact: (revision, id) => requireElectronApi(electronAPI).invoke('memory:remove', revision, id),
    clearMemory: (revision) => requireElectronApi(electronAPI).invoke('memory:clear', revision),
    onMemoryChanged: (callback) => electronAPI?.subscribe('memory:changed', callback),
  };
}

function requireElectronApi(electronAPI: ElectronAPI | undefined): ElectronAPI {
  if (!electronAPI) {
    throw new Error('Electron API is unavailable.');
  }
  return electronAPI;
}
