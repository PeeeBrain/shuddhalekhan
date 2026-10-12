import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { AuditRunSummary, TranscriptionReadiness } from '../../types/ipc';
import { formatBinding } from '../../shared/shortcut-bindings';
import type { SettingsSectionProps } from './settings-section-props';
import type { SettingsSectionId } from './settings-nav';
import { Keycaps, Tag, type TagTone } from './ui/rows';
import { SectionHeader, SettingsCard, SettingsPanel, SettingsPanelHeader } from './ui/SectionHeader';

interface HomeSettingsProps extends SettingsSectionProps {
  onOpenRun: (agentRunId: string) => void;
}

const READINESS_TONE: Record<TranscriptionReadiness['state'], TagTone> = {
  ready: 'success',
  checking: 'neutral',
  degraded: 'warning',
  unavailable: 'error',
};

const READINESS_LABEL: Record<TranscriptionReadiness['state'], string> = {
  ready: 'Ready',
  checking: 'Checking',
  degraded: 'Degraded',
  unavailable: 'Not ready',
};

/** Landing section: is everything ready, how do I start, what happened lately. */
export function HomeSettings({ config, mcpStatuses, settingsIpc, onNavigate, onOpenRun }: HomeSettingsProps) {
  const [readiness, setReadiness] = useState<TranscriptionReadiness | null>(null);
  const [runs, setRuns] = useState<AuditRunSummary[] | null>(null);

  useEffect(() => {
    const off = settingsIpc.onTranscriptionReadinessChanged(setReadiness);
    settingsIpc.checkTranscriptionReadiness().then(setReadiness).catch(() => setReadiness(null));
    settingsIpc.getAuditRuns().then((all) => setRuns(all.slice(0, 5))).catch(() => setRuns([]));
    return () => off?.();
  }, [settingsIpc]);

  const servers = config.agent.mcpServers;
  const connected = servers.filter((server) => mcpStatuses[server.id]?.status === 'connected').length;
  const { dictation, agent } = config.shortcuts;
  const hasChosenMic = Boolean(config.selectedDeviceId) && config.selectedDeviceId !== 'default';

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Home"
        description={(
          <>
            {dictation.binding ? (
              <>Press <InlineKeys binding={formatBinding(dictation.binding)} /> to dictate</>
            ) : (
              <LinkButton onClick={() => onNavigate('shortcuts')}>Assign a Dictation shortcut</LinkButton>
            )}
            {config.agent.enabled && agent.binding ? (
              <> or <InlineKeys binding={formatBinding(agent.binding)} /> to ask the agent</>
            ) : null}
            .
          </>
        )}
      />

      <SettingsPanel>
        <SettingsPanelHeader title="Readiness" />
        <SettingsCard>
          <StatusRow
            label="Speech engine"
            detail={readiness?.message ?? 'Checking…'}
            tone={readiness ? READINESS_TONE[readiness.state] : 'neutral'}
            status={readiness ? READINESS_LABEL[readiness.state] : 'Checking'}
            section="transcription"
            onNavigate={onNavigate}
          />
          <StatusRow
            label="Microphone"
            detail={hasChosenMic ? 'Chosen device' : 'Follows the Windows default input'}
            tone="success"
            status={hasChosenMic ? 'Selected' : 'System default'}
            section="shortcuts"
            onNavigate={onNavigate}
          />
          <StatusRow
            label="Agent Mode"
            detail={config.agent.enabled ? config.agent.provider.model || 'No model set' : 'Voice commands to an agent with your tools'}
            tone={config.agent.enabled ? 'success' : 'neutral'}
            status={config.agent.enabled ? 'On' : 'Off'}
            section="agent"
            onNavigate={onNavigate}
          />
          {config.agent.enabled ? (
            <StatusRow
              label="MCP servers"
              detail={servers.length ? servers.map((server) => server.displayName).join(', ') : 'No tools connected yet'}
              tone={servers.length === 0 ? 'neutral' : connected === servers.length ? 'success' : 'warning'}
              status={`${connected} of ${servers.length} connected`}
              section="mcp"
              onNavigate={onNavigate}
            />
          ) : null}
        </SettingsCard>
      </SettingsPanel>

      {runs && runs.length > 0 ? (
        <SettingsPanel>
          <SettingsPanelHeader
            title="Recent agent runs"
            actions={(
              <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => onNavigate('history')}>
                View all
              </button>
            )}
          />
          <SettingsCard className="px-1.5 py-1.5">
            {runs.map((run) => (
              <button
                key={run.agentRunId}
                type="button"
                onClick={() => onOpenRun(run.agentRunId)}
                className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="w-16 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {new Date(run.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{run.transcript || 'Empty prompt'}</span>
                {run.status === 'completed' ? null : <Tag tone={run.status === 'failed' ? 'error' : 'neutral'}>{run.status.charAt(0).toUpperCase() + run.status.slice(1)}</Tag>}
                <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
              </button>
            ))}
          </SettingsCard>
        </SettingsPanel>
      ) : null}
    </div>
  );
}

/** Small inline keycaps that sit in a sentence instead of headlining the page. */
function InlineKeys({ binding }: { binding: string }) {
  return (
    <span className="inline-flex align-middle [&_kbd]:min-h-5 [&_kbd]:px-1.5 [&_kbd]:py-0 [&_kbd]:shadow-none">
      <Keycaps value={binding} />
    </span>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-foreground underline underline-offset-4">
      {children}
    </button>
  );
}

function StatusRow({ label, detail, tone, status, section, onNavigate }: {
  label: string;
  detail: string;
  tone: TagTone;
  status: string;
  section: SettingsSectionId;
  onNavigate: (section: SettingsSectionId) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onNavigate(section)}
      className="group flex w-full items-center gap-4 border-b border-border/50 py-3 text-left last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </div>
      <Tag tone={tone}>{status}</Tag>
      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground transition-opacity group-hover:text-foreground" />
    </button>
  );
}
