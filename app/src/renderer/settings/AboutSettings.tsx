import { Button } from '@/components/ui/button';
import { SectionHeader } from './ui/SectionHeader';
import { ReadOnlyRow } from './ui/rows';
import type { SettingsSectionProps } from './settings-section-props';

export function AboutSettings({
  appInfo,
  updateStatus,
  settingsIpc,
  onUpdateStatusChange,
}: SettingsSectionProps) {
  const statusText = updateStatus?.message ?? 'Update status unavailable';

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
    </div>
  );
}
