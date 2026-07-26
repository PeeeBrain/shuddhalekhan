import { Button } from '@/components/ui/button';
import { SectionHeader } from './ui/SectionHeader';
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
      <div className="rounded-lg border border-border/60 bg-card px-6">
        <ReadOnlyRow label="Version" value={appInfo?.version ?? 'Unknown'} />
        <ReadOnlyRow label="Update status" value={statusText} />
        <div className="py-5">
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
      {releaseNotes.length > 0 ? (
        <section
          className="rounded-lg border border-border/60 bg-card px-6 py-5"
          aria-labelledby="release-notes-heading"
        >
          <h3 id="release-notes-heading" className="text-base font-semibold">
            What&apos;s new
          </h3>
          <div className="mt-1 text-xs text-muted-foreground">
            {releaseNotes.map((release) => `v${release.version}`).join(', ')}
          </div>
          <div className="mt-4 text-sm leading-relaxed text-foreground">
            {releaseNotes.map((release) => (
              <div key={release.version}>{renderMarkdown(release.notes)}</div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
