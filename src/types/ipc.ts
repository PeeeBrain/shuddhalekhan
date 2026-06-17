export type AudioDevice = {
  deviceId: string;
  label: string;
  kind: 'audioinput';
};

export type RecordingIntent = 'dictation' | 'agent';

export type AgentToolApprovalPolicy = 'disabled' | 'alwaysAsk' | 'alwaysAllow';

export type McpToolPolicyKey = `${string}:${string}`;

export type McpServerTransport =
  | {
      type: 'stdio';
      command: string;
      args: string[];
      envVarNames: string[];
    }
  | {
      type: 'http';
      url: string;
    };

export interface McpDiscoveredTool {
  name: string;
  description: string;
  inputSchema?: unknown;
  discoveredAt: string;
}

export interface McpServerConfig {
  id: string;
  displayName: string;
  enabled: boolean;
  transport: McpServerTransport;
  discoveredTools: McpDiscoveredTool[];
  toolPolicies: Record<McpToolPolicyKey, AgentToolApprovalPolicy>;
}

export interface RendererToMainSendChannels {
  'audio-window-ready': () => void;
  'audio-data-ready': (audioData: ArrayBuffer) => void;
  'audio-devices': (devices: AudioDevice[]) => void;
  'audio-level-changed': (level: number) => void;
  'audio-duration-changed': (seconds: number) => void;
  'agent-toast:content-size': (height: number) => void;
  'agent-toast:dismiss': () => void;
}

export interface DictationTargetSnapshot {
  hwnd: number;
  processId: number;
  threadId: number;
  windowClass: string;
  executablePath: string | null;
  capturedAt: string;
}

export type PasteStrategy = 'ctrl-v' | 'shift-insert' | 'ctrl-shift-v';

export type InjectResult =
  | { kind: 'input-dispatched'; acceptedEvents: number }
  | { kind: 'input-blocked'; acceptedEvents: number; reason?: string }
  | { kind: 'target-changed'; reason: string }
  | { kind: 'clipboard-conflict'; reason: string }
  | { kind: 'error'; message: string };

export interface RendererToMainInvokeChannels {
  'audio:start-recording': () => void;
  'audio:stop-recording': () => Promise<string>;
  'audio:get-devices': () => Promise<AudioDevice[]>;
  'audio:select-device': (deviceId: string) => void;
  'config:get': () => Promise<AppConfig>;
  'config:set': (key: keyof AppConfig, value: unknown) => void;
  'settings:open': () => void;
  'clipboard:inject-text': (text: string) => Promise<InjectResult>;
  'agent:approval-decision': (
    agentRunId: string,
    approvalId: string,
    decision: 'approved' | 'denied',
    message?: string
  ) => void;
  'mcp:test-server': (serverId: string) => void;
  'app:get-info': () => Promise<AppInfo>;
  'updater:get-status': () => Promise<UpdateStatus>;
  'updater:check': () => Promise<UpdateStatus>;
  'audit:get-runs': () => Promise<AuditRunSummary[]>;
  'audit:get-run-detail': (agentRunId: string) => Promise<AuditEventDetail[]>;
}

export interface MainToRendererChannels {
  'audio:start-recording': () => void;
  'audio:stop-recording': () => void;
  'audio:select-device': (deviceId: string) => void;
  'recording:mode-changed': (intent: RecordingIntent) => void;
  'recording:started': () => void;
  'recording:stopped': () => void;
  'audio:level-changed': (level: number) => void;
  'audio:duration-changed': (seconds: number) => void;
  'agent-toast:update': (state: AgentToastState) => void;
  'mcp:server-status': (status: McpServerRuntimeStatus) => void;
  'updater:status-changed': (status: UpdateStatus) => void;
  'audit:run-updated': (agentRunId: string) => void;
}

export type McpServerRuntimeStatus = {
  serverId: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'failed';
  message?: string;
};

export type AgentToastState =
  | {
      kind: 'status';
      agentRunId: string;
      message: string;
    }
  | {
      kind: 'streaming';
      agentRunId: string;
      response: string;
    }
  | {
      kind: 'approval';
      agentRunId: string;
      approvalId: string;
      serverId: string;
      toolName: string;
      modelToolName: string;
      arguments: unknown;
      expiresAt: string;
    }
  | {
      kind: 'completed';
      agentRunId: string;
      response: string;
      toolSummary: string[];
    }
  | {
      kind: 'failed';
      agentRunId: string;
      error: string;
    }
  | {
      kind: 'cancelled';
      agentRunId: string;
    }
  | {
      kind: 'config';
      message: string;
    };

export interface PasteStrategyConfig {
  default: PasteStrategy;
  overrides: Record<string, PasteStrategy>;
}

export interface AppConfig {
  whisperUrl: string;
  selectedDeviceId: string | null;
  removeFillerWords: boolean;
  language: string;
  task: 'transcribe' | 'translate';
  dictionary: string[];
  pasteStrategy: PasteStrategyConfig;
  agent: {
    enabled: boolean;
    provider: {
      baseUrl: string;
      model: string;
      apiKeyEnvVar: string;
      thinkingEnabled: boolean;
    };
    mcpServers: McpServerConfig[];
  };
}

export interface AppInfo {
  name: string;
  version: string;
  isPackaged: boolean;
}

export type UpdateStatus =
  | {
      state: 'idle';
      currentVersion: string;
      message: string;
      checkedAt: string | null;
    }
  | {
      state: 'checking';
      currentVersion: string;
      message: string;
      checkedAt: string | null;
    }
  | {
      state: 'available';
      currentVersion: string;
      availableVersion: string;
      message: string;
      checkedAt: string;
    }
  | {
      state: 'downloading';
      currentVersion: string;
      availableVersion: string;
      percent: number | null;
      message: string;
      checkedAt: string;
    }
  | {
      state: 'downloaded';
      currentVersion: string;
      availableVersion: string;
      message: string;
      checkedAt: string;
    }
  | {
      state: 'latest';
      currentVersion: string;
      latestVersion: string;
      message: string;
      checkedAt: string;
    }
  | {
      state: 'error';
      currentVersion: string;
      message: string;
      checkedAt: string;
    };

export interface AuditRunSummary {
  agentRunId: string;
  startedAt: string;
  transcript: string;
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'running';
  response?: string;
  error?: string;
  tools: string[];
}

export interface AuditEventDetail {
  id: number;
  agentRunId: string;
  eventType: string;
  payload: Record<string, any>;
  createdAt: string;
}
