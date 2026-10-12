import { useEffect, useState, useTransition, useCallback, useRef } from 'react';
import type { SettingsIpc } from './settings-ipc';
import type { AuditRunSummary, AuditEventDetail } from '../../types/ipc';
import { renderMarkdown } from '../markdown';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tag } from './ui/rows';
import {
  XCircle,
  ChevronRight,
  Copy,
  Check,
  RotateCw,
  Search,
} from 'lucide-react';
import {
  getNextListboxIndex,
  isListboxActivateKey,
  isListboxNavKey,
} from './audit-history-nav';
import {
  filterAuditRuns,
  STATUS_FILTERS,
  summarizeRunError,
  type StatusFilter,
} from './audit-history-model';

interface AuditHistorySettingsProps {
  settingsIpc: SettingsIpc;
  /** Run to open first, e.g. when arriving from Home or the command palette. */
  initialRunId?: string | null;
}

const LIVE_REFRESH_DEBOUNCE_MS = 500;

export function AuditHistorySettings({ settingsIpc, initialRunId = null }: AuditHistorySettingsProps) {
  const [runs, setRuns] = useState<AuditRunSummary[]>([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId);
  const [selectedRunEvents, setSelectedRunEvents] = useState<AuditEventDetail[] | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [runsLoadFailed, setRunsLoadFailed] = useState(false);
  const [detailLoadFailed, setDetailLoadFailed] = useState(false);
  const selectedRunIdRef = useRef<string | null>(initialRunId);
  const runsQueryInFlightRef = useRef<Promise<void> | null>(null);
  const detailQueryInFlightRef = useRef<string | null>(null);
  const liveRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingUpdatedRunIdsRef = useRef(new Set<string>());

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  const fetchRuns = useCallback(() => {
    if (runsQueryInFlightRef.current) return runsQueryInFlightRef.current;

    const query = settingsIpc.getAuditRuns()
      .then((data) => {
        startTransition(() => {
          setRuns(data);
        });
        setRunsLoadFailed(false);
        if (data.length > 0 && !selectedRunIdRef.current) {
          setIsLoadingDetail(true);
          setSelectedRunId(data[0].agentRunId);
        }
      })
      .catch((err) => {
        console.error('Failed to fetch audit runs:', err);
        setRunsLoadFailed(true);
      })
      .finally(() => {
        runsQueryInFlightRef.current = null;
      });

    runsQueryInFlightRef.current = query;
    return query;
  }, [settingsIpc]);

  const fetchRunDetail = useCallback((runId: string, showLoading = false) => {
    if (detailQueryInFlightRef.current === runId) return;
    detailQueryInFlightRef.current = runId;
    if (showLoading) setIsLoadingDetail(true);

    settingsIpc
      .getAuditRunDetail(runId)
      .then((detail) => {
        if (selectedRunIdRef.current === runId) {
          setSelectedRunEvents(detail);
          setDetailLoadFailed(false);
        }
      })
      .catch((err) => {
        console.error(`Failed to fetch events for run ${runId}:`, err);
        if (selectedRunIdRef.current === runId) {
          setDetailLoadFailed(true);
        }
      })
      .finally(() => {
        if (detailQueryInFlightRef.current === runId) {
          detailQueryInFlightRef.current = null;
        }
        if (selectedRunIdRef.current === runId) {
          setIsLoadingDetail(false);
        }
      });
  }, [settingsIpc]);

  const selectRun = useCallback((runId: string) => {
    setSelectedRunEvents(null);
    setDetailLoadFailed(false);
    setIsLoadingDetail(true);
    setSelectedRunId(runId);
  }, []);

  const visibleRuns = filterAuditRuns(runs, query, statusFilter);

  const handleRunListKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isListboxActivateKey(e.key)) {
      e.preventDefault();
      const active = visibleRuns.find((r) => r.agentRunId === selectedRunId);
      if (active) selectRun(active.agentRunId);
      return;
    }
    if (!isListboxNavKey(e.key)) return;
    e.preventDefault();
    const currentIndex = visibleRuns.findIndex((r) => r.agentRunId === selectedRunId);
    const nextIndex = getNextListboxIndex(currentIndex, e.key, visibleRuns.length);
    if (nextIndex === currentIndex || nextIndex < 0 || nextIndex >= visibleRuns.length) return;
    const nextRun = visibleRuns[nextIndex];
    if (!nextRun) return;
    selectRun(nextRun.agentRunId);
    const container = e.currentTarget;
    requestAnimationFrame(() => {
      const items = container.querySelectorAll<HTMLElement>('[role="option"]');
      items[nextIndex]?.focus();
    });
  }, [visibleRuns, selectedRunId, selectRun]);

  useEffect(() => {
    fetchRuns();

    const unsubscribe = settingsIpc.onAuditRunUpdated((updatedRunId) => {
      pendingUpdatedRunIdsRef.current.add(updatedRunId);
      if (liveRefreshTimerRef.current) {
        clearTimeout(liveRefreshTimerRef.current);
      }

      liveRefreshTimerRef.current = setTimeout(() => {
        liveRefreshTimerRef.current = null;
        const updatedRunIds = pendingUpdatedRunIdsRef.current;
        pendingUpdatedRunIdsRef.current = new Set<string>();
        void fetchRuns();

        const selected = selectedRunIdRef.current;
        if (selected && updatedRunIds.has(selected)) {
          fetchRunDetail(selected);
        }
      }, LIVE_REFRESH_DEBOUNCE_MS);
    });

    return () => {
      unsubscribe?.();
      if (liveRefreshTimerRef.current) {
        clearTimeout(liveRefreshTimerRef.current);
      }
    };
  }, [settingsIpc, fetchRuns, fetchRunDetail]);

  useEffect(() => {
    if (!selectedRunId) {
      return;
    }

    queueMicrotask(() => {
      fetchRunDetail(selectedRunId);
    });
  }, [selectedRunId, fetchRunDetail]);

  const selectedRunSummary = runs.find((r) => r.agentRunId === selectedRunId);

  return (
    <div className="flex h-full flex-1 overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="flex h-full w-72 flex-col border-r border-border/60">
        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 p-2">
          <div className="relative min-w-0 flex-1">
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search runs"
              aria-label="Search runs"
              className="h-8 border-transparent bg-transparent pl-8 text-[13px] shadow-none focus-visible:border-border"
            />
          </div>
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
            <SelectTrigger aria-label="Filter runs by status" className="h-8 w-auto gap-1 border-transparent bg-transparent px-2 text-xs text-muted-foreground shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {STATUS_FILTERS.map((filter) => (
                <SelectItem key={filter.value} value={filter.value}>{filter.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh agent history"
            onClick={fetchRuns}
            disabled={isPending}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
          >
            <RotateCw className={`h-4 w-4 ${isPending ? 'motion-safe:animate-spin' : ''}`} />
          </Button>
        </div>
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-0.5 p-1.5" role="listbox" aria-label="Agent run history" onKeyDown={handleRunListKeyDown}>
            {runsLoadFailed ? (
              <div role="alert" className="py-2 text-center text-xs text-destructive">
                Couldn&apos;t load run history.
              </div>
            ) : null}
            {runs.length === 0 && !runsLoadFailed ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                No agent runs recorded yet.
              </div>
            ) : null}
            {runs.length > 0 && visibleRuns.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                No runs match.
              </div>
            ) : null}
            {visibleRuns.map((run) => {
              const isActive = selectedRunId === run.agentRunId;
              return (
                  <div
                    key={run.agentRunId}
                    role="option"
                    aria-selected={isActive}
                    tabIndex={isActive ? 0 : -1}
                    onClick={() => selectRun(run.agentRunId)}
                    className={`cursor-pointer rounded-lg px-3 py-2.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      isActive ? 'bg-secondary' : 'hover:bg-muted/30'
                    }`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {formatDate(run.startedAt)}, {formatTime(run.startedAt)}
                      </span>
                      {run.status === 'completed' ? null : <StatusBadge status={run.status} />}
                    </div>
                    <p className="mb-1.5 line-clamp-2 select-none text-[13px] leading-5 text-foreground">
                      {run.transcript || <span className="italic text-muted-foreground/80">(Empty prompt)</span>}
                    </p>
                    {run.tools.length > 0 && (
                      <p className="truncate font-mono text-[10px] text-muted-foreground">
                        {run.tools.slice(0, 3).map((tool) => tool.split('.').pop()).join(' · ')}
                        {run.tools.length > 3 ? ` +${run.tools.length - 3}` : ''}
                      </p>
                    )}
                  </div>
              );
            })}
          </div>
        </ScrollArea>
      </div>
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {selectedRunId ? (
          <ScrollArea className="h-full min-h-0 flex-1">
            <div className="max-w-3xl space-y-6 px-6 py-5">
              <header className="space-y-1.5">
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  {selectedRunSummary ? (
                    <>
                      <span className="tabular-nums">{formatDate(selectedRunSummary.startedAt)}, {formatTime(selectedRunSummary.startedAt)}</span>
                      <StatusBadge status={selectedRunSummary.status} size="lg" />
                    </>
                  ) : null}
                </p>
                <h3 className="select-text text-base font-medium leading-snug">
                  {selectedRunSummary?.transcript || <span className="italic text-muted-foreground">(No prompt recorded)</span>}
                </h3>
              </header>

              {selectedRunSummary?.response && (
                <div className="select-text text-sm leading-relaxed">
                  {renderMarkdown(selectedRunSummary.response)}
                </div>
              )}

              {selectedRunSummary?.error && (
                <RunError error={selectedRunSummary.error} />
              )}

              <details className="group">
                <summary className="flex cursor-pointer select-none items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
                  <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
                  Activity{selectedRunEvents?.length ? ` · ${selectedRunEvents.length} steps` : ''}
                </summary>
                <div className="mt-2">
                  {detailLoadFailed ? (
                    <p role="alert" className="text-xs text-destructive">Couldn&apos;t load events for this run.</p>
                  ) : null}
                  {isLoadingDetail && !selectedRunEvents ? (
                    <p className="text-xs text-muted-foreground">Loading events...</p>
                  ) : selectedRunEvents && selectedRunEvents.length > 0 ? (
                    <ol className="divide-y divide-border/40">
                      {selectedRunEvents.map((event) => (
                        <TimelineNode key={event.id} event={event} />
                      ))}
                    </ol>
                  ) : !detailLoadFailed ? (
                    <p className="text-xs text-muted-foreground">No detailed timeline events found.</p>
                  ) : null}
                  <p className="pt-3 font-mono text-[10px] text-muted-foreground/70">
                    Run ID <span className="select-all">{selectedRunId}</span>
                  </p>
                </div>
              </details>
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8">
            <p className="max-w-xs text-center text-xs text-muted-foreground">
              Select an agent run from the history list to inspect its execution.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}


function formatTime(isoString: string) {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch {
    return '00:00:00';
  }
}

function formatDate(isoString: string) {
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function StatusBadge({
  status,
  size = 'sm',
}: {
  status: AuditRunSummary['status'];
  size?: 'sm' | 'lg';
}) {
  const className = size === 'lg' ? 'text-xs' : 'text-[10px]';

  switch (status) {
    case 'completed':
      return (
        <Tag tone="success" className={className}>
          Completed
        </Tag>
      );
    case 'failed':
      return (
        <Tag tone="error" className={className}>
          Failed
        </Tag>
      );
    case 'cancelled':
      return (
        <Tag tone="neutral" className={className}>
          Cancelled
        </Tag>
      );
    case 'interrupted':
      return (
        <Tag tone="warning" className={className}>
          Interrupted
        </Tag>
      );
    case 'running':
      return (
        <Tag tone="info" className={className}>
          Running
        </Tag>
      );
    default:
      return null;
  }
}

interface TimelineNodeProps {
  event: AuditEventDetail;
}

function TimelineNode({ event }: TimelineNodeProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(event.payload, null, 2));
      setCopyState('copied');
    } catch (err) {
      console.error('Failed to copy payload:', err);
      setCopyState('failed');
    } finally {
      setTimeout(() => setCopyState('idle'), 2000);
    }
  };

  const info = getEventDisplayInfo(event);
  const row = (
    <span className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-3 py-2 text-xs">
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{formatTime(event.createdAt)}</span>
      <span className="min-w-0">
        <span className={`font-medium ${info.tone ?? 'text-foreground'}`}>{info.title}</span>
        <span className="text-muted-foreground"> · {info.description}</span>
      </span>
    </span>
  );

  if (!hasPayload(event)) return <li>{row}</li>;

  return (
    <li>
      <details>
        <summary className="cursor-pointer list-none rounded-md hover:bg-muted/20">{row}</summary>
        <div className="relative mb-2 ml-[5.25rem] rounded-md bg-muted/40">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleCopy}
            className="absolute right-1.5 top-1.5 h-6 w-6 text-muted-foreground hover:text-foreground"
            title="Copy JSON Payload"
          >
            {copyState === 'copied' ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : copyState === 'failed' ? (
              <XCircle className="h-3.5 w-3.5 text-destructive" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
          <pre className="max-h-64 max-w-full select-text overflow-auto whitespace-pre-wrap p-3 pr-9 font-mono text-[11px] leading-normal text-foreground/90">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </div>
      </details>
    </li>
  );
}

function RunError({ error }: { error: string }) {
  const summary = summarizeRunError(error);
  return (
    <div className="space-y-1.5 border-l-2 border-destructive/60 pl-3">
      <p className="select-text text-sm leading-relaxed text-foreground">{summary}</p>
      {summary !== error.trim() ? (
        <details className="text-xs">
          <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">Technical details</summary>
          <pre className="mt-1.5 max-h-48 select-text overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-[11px] leading-5 text-foreground/80">
            {error}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function hasPayload(event: AuditEventDetail): boolean {
  if (!event.payload) return false;
  return Object.keys(event.payload).length > 0;
}

interface EventDisplay {
  title: string;
  description: string;
  /** Text class for the title when the step went wrong or needed the user. */
  tone?: string;
}

function getEventDisplayInfo(event: AuditEventDetail): EventDisplay {
  const p = event.payload;

  switch (event.eventType) {
    case 'run_started':
      return {
        title: 'Started',
        description: `"${formatPromptPreview(p.transcript)}"`,
      };
    case 'status':
      return {
        title: 'Status',
        description: unknownAsString(p.status, 'Agent status update'),
      };
    case 'tool_requests':
      return {
        title: 'Tool requested',
        description: toolCallNames(p.toolCalls),
      };
    case 'tool_results': {
      const count = Array.isArray(p.toolResults) ? p.toolResults.length : 0;
      return {
        title: 'Tool results',
        description: `${count} result${count === 1 ? '' : 's'}`,
      };
    }
    case 'approval_requested':
      return {
        title: 'Approval requested',
        tone: 'text-warning',
        description: formatServerTool(p.serverId, p.toolName),
      };
    case 'approval_decision':
      return {
        title: p.approved ? 'Approved' : 'Denied',
        description: p.approved
          ? formatServerTool(p.serverId, p.toolName)
          : unknownAsString(p.message, 'No reason given'),
      };
    case 'mcp_tool_execute_started':
      return {
        title: 'Calling tool',
        description: formatServerTool(p.serverId, p.toolName),
      };
    case 'mcp_tool_execute_result':
      return {
        title: 'Tool finished',
        description: formatServerTool(p.serverId, p.toolName),
      };
    case 'mcp_tool_execute_error':
      return {
        title: 'Tool failed',
        tone: 'text-destructive',
        description: `${formatServerTool(p.serverId, p.toolName)}: ${summarizeRunError(unknownAsString(p.error, 'Unknown error'))}`,
      };
    case 'empty_response_degraded':
      return {
        title: 'Empty response',
        description: unknownAsString(p.reason, 'Received an empty response from model'),
      };
    case 'max_step_guardrail':
      return {
        title: 'Step limit reached',
        tone: 'text-warning',
        description: `${typeof p.stepCount === 'number' ? p.stepCount : '?'} steps`,
      };
    case 'run_completed':
      return {
        title: 'Completed',
        description: 'Response delivered',
      };
    case 'run_interrupted':
      return {
        title: 'Interrupted',
        description: unknownAsString(p.reason, 'Ended early'),
      };
    case 'run_cancelled':
    case 'cancelled':
      return {
        title: 'Cancelled',
        description: unknownAsString(p.reason, 'Cancelled by you'),
      };
    case 'run_failed':
      return {
        title: 'Failed',
        tone: 'text-destructive',
        description: summarizeRunError(unknownAsString(p.error, 'Unknown error')),
      };
    default:
      return {
        title: event.eventType.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        description: 'Audit log entry',
      };
  }
}

function unknownAsString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function toolCallNames(calls: unknown): string {
  if (!Array.isArray(calls)) return 'unknown tools';
  const names = calls
    .filter((tc): tc is { toolName: string } =>
      typeof tc === 'object' && tc !== null && 'toolName' in tc && typeof tc.toolName === 'string')
    .map((tc) => tc.toolName.split('__').join('.'));
  return names.length > 0 ? names.join(', ') : 'unknown tools';
}

function formatServerTool(serverId: unknown, toolName: unknown): string {
  return `${unknownAsString(serverId, 'unknown-server')}.${unknownAsString(toolName, 'unknown-tool')}`;
}

function formatPromptPreview(transcript: unknown): string {
  if (typeof transcript !== 'string' || transcript.length === 0) {
    return '';
  }

  const normalized = transcript.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
}
