import { useState } from 'react';
import { useDesktopStatus } from './use-desktop-status';
import type { SettingsIpc } from './settings-ipc';
import { ToggleRow } from './ui/rows';
import { SettingsCard, SettingsPanel, SettingsPanelHeader } from './ui/SectionHeader';
import { ipcErrorMessage } from './use-settings-persistence';

/** KDE Wayland best-effort insertion test mode; renders only in Wayland sessions. */
export function WaylandInsertionPanel({ settingsIpc }: { settingsIpc: SettingsIpc }) {
  const status = useDesktopStatus(settingsIpc)?.waylandInsertion;
  const [error, setError] = useState<string>();
  if (!status) return null;

  const update = async (enabled: boolean) => {
    setError(undefined);
    try {
      await settingsIpc.setWaylandInsertion(enabled);
    } catch (cause) {
      setError(ipcErrorMessage(cause, 'Could not change Wayland text insertion.'));
    }
  };

  return (
    <SettingsPanel aria-label="Wayland text insertion">
      <SettingsPanelHeader title="Wayland text insertion" />
      <SettingsCard>
        <ToggleRow
          title="Best-effort insertion (test mode)"
          description={status.state === 'off'
            ? 'Pastes into the window that was active when recording began, without checking which field inside it has focus. Turning this on asks KDE to allow keyboard control. It uses the clipboard and leaves the transcript there.'
            : status.message}
          checked={status.state === 'ready' || status.state === 'setting-up'}
          disabled={status.state === 'unsupported'}
          errorId="wayland-insertion-error"
          error={error}
          onChange={(enabled) => void update(enabled)}
        />
      </SettingsCard>
    </SettingsPanel>
  );
}
