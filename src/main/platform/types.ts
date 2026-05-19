import type { RecordingIntent } from '../../types/ipc';

export type SupportedPlatform = 'win32' | 'darwin' | 'linux';

export type CapabilityState =
  | 'ready'
  | 'unassigned'
  | 'needsSetup'
  | 'blocked'
  | 'unsupported';

export interface CapabilityStatus {
  state: CapabilityState;
  message: string;
}

export interface PlatformCapabilities {
  platform: SupportedPlatform;
  desktop: string;
  shortcuts: Record<RecordingIntent, CapabilityStatus>;
  textInjection: CapabilityStatus;
}

export interface PlatformProvider {
  getCapabilities: () => PlatformCapabilities;
}
