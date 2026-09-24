import { Button } from '@/components/ui/button';
import { SectionHeader, SettingsPanel, SettingsPanelHeader } from './ui/SectionHeader';
import { ReadOnlyRow } from './ui/rows';
import type { SettingsSectionProps } from './settings-section-props';
import { renderMarkdown } from '../markdown';

export function AboutSettings({
  appInfo,
  updateStatus,
  bundledReleaseNotes,
  settingsIpc,
  onUpdateStatusChange,
}: SettingsSectionProps) {
  const statusText = updateStatus?.message ?? 'Update status unavailable';
  const availableReleaseNotes =
    updateStatus?.state === 'available' ||
    updateStatus?.state === 'downloading' ||
    updateStatus?.state === 'downloaded'
      ? updateStatus.releaseNotes
      : [];
  const releaseNotes =
    availableReleaseNotes.length > 0
      ? availableReleaseNotes
      : bundledReleaseNotes
        ? [bundledReleaseNotes]
        : [];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="About"
        description="Version and update status for Shuddhalekhan."
      />
      <SettingsPanel className="overflow-hidden">
        <SettingsPanelHeader
          eyebrow="Application"
          title="Shuddhalekhan"
          description="A local voice interface for dictation and one-off agent commands."
        />
        <div>
          <ReadOnlyRow label="Version" value={appInfo?.version ?? 'Unknown'} />
          <ReadOnlyRow label="Update status" value={statusText} />
          <div className="py-4">
            <Button
              className="w-fit min-w-36"
              disabled={updateStatus?.state === 'checking'}
              onClick={() => {
                settingsIpc
                  .checkForUpdates()
                  .then(onUpdateStatusChange)
                  .catch((err) => {
                    console.error('Failed to check for updates:', err);
                  });
              }}
            >
              {updateStatus?.state === 'checking' ? 'Checking...' : 'Check for Updates'}
            </Button>
          </div>
        </div>
      </SettingsPanel>
      {releaseNotes.length > 0 ? (
        <SettingsPanel aria-labelledby="release-notes-heading">
          <SettingsPanelHeader
            eyebrow="Release notes"
            title="What's new"
            description={releaseNotes.map((release) => `v${release.version}`).join(', ')}
          />
          <div className="px-6 py-4 text-sm leading-relaxed text-foreground">
            {releaseNotes.map((release) => (
              <div key={release.version}>{renderMarkdown(release.notes)}</div>
            ))}
          </div>
        </SettingsPanel>
      ) : null}
    </div>
  );
}
