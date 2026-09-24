import { SectionHeader, SettingsPanel, SettingsPanelHeader } from './ui/SectionHeader';
import { ReadOnlyRow } from './ui/rows';
import type { SettingsSectionProps } from './settings-section-props';

export function AudioSettings({ config }: SettingsSectionProps) {
  return (
    <div className="space-y-6">
      <SectionHeader
        title="Audio"
        description="Review the shared input path used by Dictation and Agent Mode. Recording behavior is configured per intent under Shortcuts."
      />
      <SettingsPanel className="overflow-hidden">
        <SettingsPanelHeader
          eyebrow="Shared input"
          title="One microphone path"
          description="Both recording modes use the same captured audio before they branch at transcription."
        />
        <div>
          <ReadOnlyRow
            label="Selected device"
            value={config.selectedDeviceId ?? 'Default input device'}
          />
          <ReadOnlyRow label="Capture path" value="Shared by Dictation and Agent Mode" />
        </div>
      </SettingsPanel>
    </div>
  );
}
