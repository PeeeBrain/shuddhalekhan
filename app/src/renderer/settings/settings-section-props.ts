import type {
  AppConfig,
  AppInfo,
  UpdateStatus,
  VersionReleaseNotes,
} from '../../types/ipc';
import type { McpServerRuntimeStatus } from '../../types/ipc';
import type { SettingsIpc } from './settings-ipc';
import type { SettingsPersistence } from './use-settings-persistence';

export interface SettingsSectionProps {
  config: AppConfig;
  appInfo: AppInfo | null;
  updateStatus: UpdateStatus | null;
  bundledReleaseNotes: VersionReleaseNotes | null;
  mcpStatuses: Record<string, McpServerRuntimeStatus>;
  settingsIpc: SettingsIpc;
  persistence: SettingsPersistence;
  onNavigate: (section: import('./settings-nav').SettingsSectionId) => void;
  onUpdateStatusChange: (status: UpdateStatus) => void;
}
