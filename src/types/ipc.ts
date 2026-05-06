export type AudioDevice = {
  deviceId: string;
  label: string;
  kind: 'audioinput';
};

export type RecordingIntent = 'dictation' | 'agent';

export interface RendererToMainSendChannels {
  'audio-window-ready': () => void;
  'audio-data-ready': (audioData: ArrayBuffer) => void;
  'audio-devices': (devices: AudioDevice[]) => void;
  'audio-level-changed': (level: number) => void;
  'audio-duration-changed': (seconds: number) => void;
}

export interface RendererToMainInvokeChannels {
  'audio:start-recording': () => void;
  'audio:stop-recording': () => Promise<string>;
  'audio:get-devices': () => Promise<AudioDevice[]>;
  'audio:select-device': (deviceId: string) => void;
  'config:get': () => Promise<AppConfig>;
  'config:set': (key: keyof AppConfig, value: unknown) => void;
  'settings:open': () => void;
  'clipboard:inject-text': (text: string) => void;
  'app:get-info': () => Promise<AppInfo>;
  'updater:get-status': () => Promise<UpdateStatus>;
  'updater:check': () => Promise<UpdateStatus>;

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
  'updater:status-changed': (status: UpdateStatus) => void;
}

export interface AppConfig {
  whisperUrl: string;
  selectedDeviceId: string | null;
  removeFillerWords: boolean;
  agent: {
    enabled: boolean;
    provider: {
      baseUrl: string;
      model: string;
      apiKeyEnvVar: string;
    };
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
