import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { SectionHeader, SettingsCard, SettingsPanel, SettingsPanelHeader } from './ui/SectionHeader';
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
  const [checkFailed, setCheckFailed] = useState(false);
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
    <div className="space-y-8">
      <SectionHeader
        title="About"
        description="A local voice interface for dictation and one-off agent commands."
      />
      <SettingsCard>
          <ReadOnlyRow label="Version" value={appInfo?.version ?? 'Unknown'} />
          <ReadOnlyRow label="Update status" value={statusText} />
          <div className="py-3.5">
            {/* autoDownload is on, so `available` means the download has started; it sits at 0 until progress arrives. */}
            {updateStatus?.state === 'available' || updateStatus?.state === 'downloading' ? (
              <div className="mb-3.5 flex items-center gap-3">
                <Progress value={updateStatus.state === 'downloading' ? updateStatus.percent ?? 0 : 0} label="Update download" />
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {updateStatus.state === 'downloading' && updateStatus.percent !== null ? `${updateStatus.percent}%` : ''}
                </span>
              </div>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              disabled={updateStatus?.state === 'checking'}
              onClick={() => {
                setCheckFailed(false);
                settingsIpc
                  .checkForUpdates()
                  .then(onUpdateStatusChange)
                  .catch((err) => {
                    console.error('Failed to check for updates:', err);
                    setCheckFailed(true);
                  });
              }}
            >
              {updateStatus?.state === 'checking' ? 'Checking…' : 'Check for updates'}
            </Button>
            {checkFailed ? (
              <p className="mt-2 text-xs text-destructive" role="alert">
                Couldn't check for updates. Try again.
              </p>
            ) : null}
          </div>
      </SettingsCard>
      {releaseNotes.length > 0 ? (
        <SettingsPanel aria-labelledby="release-notes-heading">
          <SettingsPanelHeader
            id="release-notes-heading"
            title="What's new"
            description={releaseNotes.map((release) => `v${release.version}`).join(', ')}
          />
          <SettingsCard className="py-4 text-sm leading-relaxed text-foreground">
            {releaseNotes.map((release) => (
              <div key={release.version}>{renderMarkdown(release.notes)}</div>
            ))}
          </SettingsCard>
        </SettingsPanel>
      ) : null}
    </div>
  );
}
