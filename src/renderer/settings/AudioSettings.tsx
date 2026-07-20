import { SectionHeader } from './ui/SectionHeader';
import { ReadOnlyRow } from './ui/rows';
import type { SettingsSectionProps } from './settings-section-props';

export function AudioSettings({ config }: SettingsSectionProps) {
  return (
    <div className="space-y-6">
      <SectionHeader
        title="Audio"
        description="Review the shared input path used by Dictation and Agent Mode. Recording behavior is configured per intent under Shortcuts."
      />
      <div className="rounded-lg border border-border/60 bg-card px-6">
        <ReadOnlyRow
          label="Selected device"
          value={config.selectedDeviceId ?? 'Default input device'}
        />
        <ReadOnlyRow label="Capture path" value="Shared by Dictation and Agent Mode" />
      </div>
    </div>
  );
}
