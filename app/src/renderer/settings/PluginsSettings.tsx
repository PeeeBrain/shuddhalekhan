import { useEffect, useState } from 'react';
import { FolderOpen, Search } from 'lucide-react';
import type { PluginCatalogEntry, PluginInstallResult } from '../../types/ipc';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { SectionHeader, SettingsCard } from './ui/SectionHeader';
import { Tag } from './ui/rows';
import { ipcErrorMessage } from './use-settings-persistence';
import type { SettingsSectionProps } from './settings-section-props';

/** Installed plugins come from the pushed agent config; main owns every install and removal. */
export function PluginsSettings({ config, settingsIpc, onNavigate }: SettingsSectionProps) {
  const [catalog, setCatalog] = useState<PluginCatalogEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const installed = config.agent.plugins ?? [];

  useEffect(() => {
    let active = true;
    settingsIpc.getPluginCatalog().then(
      (entries) => active && setCatalog(entries),
      (cause) => active && setCatalogError(ipcErrorMessage(cause, 'Could not load the plugin directory.')),
    );
    return () => {
      active = false;
    };
  }, [settingsIpc, catalogAttempt]);

  const run = async (name: string, action: () => Promise<string | null>, fallback: string) => {
    setBusy(name);
    setNotice(null);
    setError(null);
    try {
      setNotice(await action());
    } catch (cause) {
      setError(ipcErrorMessage(cause, fallback));
    } finally {
      setBusy(null);
    }
  };

  const describeInstall = (result: PluginInstallResult | null) => {
    if (!result) return null;
    const signIn = result.plugin.mcpServerIds.length === 0 ? ''
      : config.agent.enabled ? ' If it needs you to sign in, your browser will open.' : ' Turn on Agent Mode to sign in.';
    const skipped = result.skipped.length ? ` Left out: ${result.skipped.join('; ')}.` : '';
    return `Installed ${result.plugin.name}.${signIn}${skipped}`;
  };

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = catalog?.filter((entry) => {
    const text = `${entry.name} ${entry.description}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Plugins"
        description="Give the agent apps like Linear, Notion, or Sentry in one step. A plugin brings the app's connection and know-how for using it."
        actions={(
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void run('folder', async () => describeInstall(await settingsIpc.installPluginFolder()), 'Could not install that folder.')}
          >
            <FolderOpen aria-hidden="true" />
            Add from folder
          </Button>
        )}
      />

      {!config.agent.enabled ? (
        <SettingsCard className="flex items-center justify-between gap-4 py-3 text-sm">
          <p className="text-muted-foreground">Plugins work once Agent Mode is on.</p>
          <Button type="button" size="sm" variant="secondary" onClick={() => onNavigate('agent')}>Agent settings</Button>
        </SettingsCard>
      ) : null}

      {error ? (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      ) : null}
      {notice ? (
        <div role="status" className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-sm">{notice}</div>
      ) : null}

      {installed.length ? (
        <section aria-labelledby="installed-plugins-heading" className="settings-panel">
          <h3 id="installed-plugins-heading" className="px-1 text-[13px] font-medium text-muted-foreground">Installed</h3>
          <SettingsCard className="divide-y divide-border/50">
            {installed.map((plugin) => (
              <div key={plugin.name} className="flex items-center justify-between gap-4 py-3">
                <p className="break-words text-sm font-medium">{plugin.name}</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={busy !== null}
                  aria-label={`Remove ${plugin.name}`}
                  onClick={() => setRemoveTarget(plugin.name)}
                >
                  {busy === plugin.name ? 'Removing…' : 'Remove'}
                </Button>
              </div>
            ))}
          </SettingsCard>
        </section>
      ) : null}

      <section aria-label="Plugin directory" className="settings-panel">
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search plugins"
            aria-label="Search plugins"
            className="pl-8"
          />
        </div>
        {!matches ? (
          <SettingsCard className="flex items-center justify-center gap-3 py-8 text-sm text-muted-foreground">
            {catalogError ?? 'Loading plugins…'}
            {catalogError ? (
              <Button type="button" size="sm" variant="secondary" onClick={() => { setCatalogError(null); setCatalogAttempt((attempt) => attempt + 1); }}>Try again</Button>
            ) : null}
          </SettingsCard>
        ) : matches.length === 0 ? (
          <SettingsCard className="py-8 text-center text-sm text-muted-foreground">No plugins match “{query}”.</SettingsCard>
        ) : (
          <SettingsCard className="divide-y divide-border/50">
            {matches.map((entry) => (
              <div key={entry.name} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium">{entry.name}</p>
                  <p className="line-clamp-2 break-words text-xs leading-5 text-muted-foreground">{entry.description}</p>
                </div>
                {installed.some((plugin) => plugin.name === entry.name) ? (
                  <Tag tone="success" className="mt-1">Installed</Tag>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy !== null}
                    aria-label={`Install ${entry.name}`}
                    onClick={() => void run(entry.name, async () => describeInstall(await settingsIpc.installPlugin(entry.name)), `Could not install ${entry.name}.`)}
                  >
                    {busy === entry.name ? 'Installing…' : 'Install'}
                  </Button>
                )}
              </div>
            ))}
          </SettingsCard>
        )}
        <p className="px-1 text-xs text-muted-foreground">From Anthropic&apos;s official Claude plugin directory.</p>
      </section>

      <ConfirmDialog
        open={removeTarget !== null}
        title={`Remove ${removeTarget ?? ''}?`}
        description="The agent loses this plugin's connections and skills."
        confirmLabel="Remove"
        onConfirm={() => {
          const name = removeTarget;
          setRemoveTarget(null);
          if (name) void run(name, async () => { await settingsIpc.removePlugin(name); return null; }, `Could not remove ${name}.`);
        }}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}
