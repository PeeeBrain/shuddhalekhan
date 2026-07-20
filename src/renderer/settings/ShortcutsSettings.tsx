import { SectionHeader } from './ui/SectionHeader';
import { KeyRow } from './ui/rows';
import type { SettingsSectionProps } from './settings-section-props';

export function ShortcutsSettings(_props: SettingsSectionProps) {
  return (
    <div className="space-y-6">
      <SectionHeader
        title="Shortcuts"
        description="Global hotkeys that start and stop recording for each intent."
      />
      <div className="rounded-lg border border-border/60 bg-card px-6">
        <KeyRow label="Dictation" value="Ctrl + Win" />
        <KeyRow label="Agent" value="Alt + Win" />
      </div>
      <p className="px-6 text-xs text-muted-foreground">
        Customizable shortcuts arrive in a later update.
      </p>
    </div>
  );
}