import { useEffect, useId, useState } from 'react';
import {
  COMPUTER_USE_TOOLS,
  COMPUTER_USE_VERSION,
  computerUseToolPolicy,
  DEFAULT_COMPUTER_USE_CONFIG,
  type ComputerUseConfig,
  type ComputerUseStatus,
  type ComputerUseToolGroup,
} from '../../shared/computer-use';
import { Button } from '@/components/ui/button';
import { SectionHeader, SettingsCard, SettingsPanel, SettingsPanelHeader } from './ui/SectionHeader';
import { Tag, ToggleRow, ToolPolicySelect } from './ui/rows';
import { ipcErrorMessage } from './use-settings-persistence';
import type { SettingsSectionProps } from './settings-section-props';

const FIELD_ID_ENABLED = 'computer-use-enabled';
const FIELD_ID_POLICIES = 'computer-use-policies';

const GROUPS: Array<{ id: ComputerUseToolGroup; title: string; description: string }> = [
  { id: 'observe', title: 'Read', description: 'List apps and windows, and read what a window shows.' },
  { id: 'act', title: 'Act', description: 'Change a window: click, fill fields, choose options.' },
  { id: 'apps', title: 'Apps', description: 'Open and quit apps by name.' },
  { id: 'clipboard', title: 'Clipboard', description: 'Off until you turn it on. The clipboard can hold passwords.' },
];

export function ComputerUseSettings({ config, persistence, settingsIpc }: SettingsSectionProps) {
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabledErrorId = useId();

  useEffect(() => {
    let active = true;
    // A pushed status is always newer than the initial read, so the read never overwrites it.
    let pushed = false;
    const off = settingsIpc.onComputerUseStatusChanged((next) => {
      pushed = true;
      setStatus(next);
    });
    settingsIpc.getComputerUseStatus()
      .then((next) => { if (active && !pushed) setStatus(next); })
      .catch((cause) => { if (active) setError(ipcErrorMessage(cause, 'Could not read Computer Use status.')); });
    return () => {
      active = false;
      off?.();
    };
  }, [settingsIpc]);

  const run = async (action: () => Promise<ComputerUseStatus | void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) setStatus(next);
    } catch (cause) {
      setError(ipcErrorMessage(cause, fallback));
    } finally {
      setBusy(false);
    }
  };

  const computerUse = config.agent.computerUse ?? DEFAULT_COMPUTER_USE_CONFIG;
  const installed = status?.state === 'installed';
  const save = (next: ComputerUseConfig, fieldId: string) => {
    void persistence.commit('agent', { ...config.agent, computerUse: next }, fieldId);
  };

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Computer Use"
        description="Let Agent Mode read and operate the apps on your desktop through their accessibility interface, the same one screen readers use."
      />

      <SettingsCard>
        <EngineRow
          status={status}
          busy={busy}
          onInstall={() => void run(settingsIpc.installComputerUse, 'Could not install Computer Use.')}
          onCancel={() => void run(settingsIpc.cancelComputerUseInstall, 'Could not cancel the download.')}
          onRemove={() => void run(settingsIpc.uninstallComputerUse, 'Could not remove Computer Use.')}
        />
        {status && status.state !== 'unsupported' ? (
          <ToggleRow
            title="Let the agent use your desktop"
            description={config.agent.enabled
              ? 'What the agent reads from a window is sent to your selected model. Each tool asks before it runs unless you change it below.'
              : 'Turn on Agent Mode first. What the agent reads from a window is sent to your selected model.'}
            checked={installed && computerUse.enabled}
            disabled={!installed || !config.agent.enabled}
            tone="agent"
            errorId={enabledErrorId}
            error={persistence.fieldErrors[FIELD_ID_ENABLED]}
            onChange={(enabled) => save({ ...computerUse, enabled }, FIELD_ID_ENABLED)}
          />
        ) : null}
      </SettingsCard>

      {error ? (
        <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive break-words">
          {error}
        </p>
      ) : null}

      {status?.state === 'unsupported' ? null : (
        <SettingsPanel aria-labelledby="computer-use-tools-heading">
          <SettingsPanelHeader
            id="computer-use-tools-heading"
            title="Tools"
            description="The same choices as MCP tools. A disabled tool is never offered to the agent."
          />
          {persistence.fieldErrors[FIELD_ID_POLICIES] ? (
            <p role="alert" className="text-xs text-destructive">{persistence.fieldErrors[FIELD_ID_POLICIES]}</p>
          ) : null}
          <SettingsCard>
            {GROUPS.map((group) => (
              <section key={group.id} aria-labelledby={`computer-use-group-${group.id}`} className="border-b border-border/50 py-3.5 last:border-b-0">
                <h4 id={`computer-use-group-${group.id}`} className="text-sm font-medium">{group.title}</h4>
                <p className="text-xs leading-5 text-muted-foreground">{group.description}</p>
                <div className="mt-2 divide-y divide-border/40">
                  {COMPUTER_USE_TOOLS.filter((tool) => tool.group === group.id).map((tool) => (
                    <div key={tool.name} className="grid grid-cols-1 items-center gap-2 py-2 sm:grid-cols-[1fr_160px] sm:gap-3">
                      <p className="min-w-0 text-[13px]">
                        {tool.label}
                        <span className="ml-2 break-all font-mono text-[11px] text-muted-foreground">{tool.name}</span>
                      </p>
                      <ToolPolicySelect
                        value={computerUseToolPolicy(computerUse, tool.name)}
                        label={tool.label}
                        onChange={(policy) => save({ ...computerUse, toolPolicies: { ...computerUse.toolPolicies, [tool.name]: policy } }, FIELD_ID_POLICIES)}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </SettingsCard>
        </SettingsPanel>
      )}
    </div>
  );
}

function EngineRow({ status, busy, onInstall, onCancel, onRemove }: {
  status: ComputerUseStatus | null;
  busy: boolean;
  onInstall: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border/50 py-3.5 last:border-b-0">
      <div className="min-w-0 max-w-xl space-y-0.5">
        <p className="flex items-center gap-2 text-sm font-medium">
          Desktop helper
          {status?.state === 'installed' ? <Tag tone="success">Installed</Tag> : null}
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          agent-desktop {COMPUTER_USE_VERSION}, open source from Vercel Labs (Apache-2.0). Downloaded from GitHub and verified before it runs. Works with GTK and Qt apps.
        </p>
        {status?.state === 'installing' ? (
          <p className="text-xs" role="status">
            {status.receivedBytes < status.totalBytes
              ? `Downloading… ${Math.round(status.receivedBytes / Math.max(1, status.totalBytes) * 100)}%`
              : 'Verifying…'}
          </p>
        ) : null}
        {status?.state === 'failed' ? <p className="text-xs text-destructive break-words" role="alert">{status.reason}</p> : null}
        {status?.state === 'unsupported' ? <p className="text-xs text-muted-foreground" role="status">{status.reason}</p> : null}
      </div>
      {status?.state === 'installed' ? (
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={busy} onClick={onRemove}>Remove</Button>
      ) : status?.state === 'installing' ? (
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      ) : status?.state === 'absent' || status?.state === 'failed' ? (
        <Button size="sm" disabled={busy} onClick={onInstall}>{status.state === 'failed' ? 'Retry' : 'Install'}</Button>
      ) : null}
    </div>
  );
}
