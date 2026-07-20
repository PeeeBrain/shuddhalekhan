import { useId } from 'react';
import { SectionHeader } from './ui/SectionHeader';
import { SelectRow, ReadOnlyRow } from './ui/rows';
import type { SettingsSectionProps } from './settings-section-props';
import type { AppConfig } from '../../types/ipc';

const FIELD_ID_ACTIVATION = 'recording-activation';

export function AudioSettings({ config, persistence }: SettingsSectionProps) {
  const { commit, fieldErrors } = persistence;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Audio"
        description="Choose how recording starts and which input device is used."
      />
      <div className="rounded-lg border border-border/60 bg-card px-6">
        <SelectRow
          label="Recording activation"
          description={
            config.recordingActivationMode === 'push-to-talk'
              ? 'Hold the hotkey to record. Release it to stop.'
              : 'Press the hotkey to start recording. Press it again to stop.'
          }
          value={config.recordingActivationMode}
          options={[
            { value: 'push-to-talk', label: 'Push to talk' },
            { value: 'toggle', label: 'Toggle recording' },
          ]}
          errorId={useId()}
          error={fieldErrors[FIELD_ID_ACTIVATION]}
          onChange={(value) =>
            commit(
              'recordingActivationMode',
              value as AppConfig['recordingActivationMode'],
              FIELD_ID_ACTIVATION,
            )
          }
        />
        <ReadOnlyRow
          label="Selected device"
          value={config.selectedDeviceId ?? 'Default input device'}
        />
        <ReadOnlyRow label="Capture path" value="Shared by Dictation and Agent Mode" />
      </div>
    </div>
  );
}