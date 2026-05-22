import { useEffect, useState, useTransition, useCallback } from 'react';
import type { SettingsIpc } from './settings-ipc';
import type { AuditRunSummary, AuditEventDetail } from '../../types/ipc';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Play,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Terminal,
  ChevronRight,
  ChevronDown,
  Copy,
  Check,
  RotateCw,
} from 'lucide-react';

interface AuditHistorySettingsProps {
  settingsIpc: SettingsIpc;
}

export function AuditHistorySettings({ settingsIpc }: AuditHistorySettingsProps) {
  const [runs, setRuns] = useState<AuditRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunEvents, setSelectedRunEvents] = useState<AuditEventDetail[] | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  const fetchRuns = useCallback(() => {
    startTransition(async () => {
      try {
        const data = await settingsIpc.getAuditRuns();
        setRuns(data);
        if (data.length > 0 && !selectedRunId) {
          setSelectedRunId(data[0].agentRunId);
        }
      } catch (err) {
        console.error('Failed to fetch audit runs:', err);
      }
    });
  }, [settingsIpc, selectedRunId]);

  useEffect(() => {
    fetchRuns();

    const unsubscribe = settingsIpc.onAuditRunUpdated((updatedRunId) => {
      // Refresh runs list
      settingsIpc.getAuditRuns().then((data) => {
        setRuns(data);
      }).catch(console.error);

      // If the currently selected run is updated, refresh its details
      if (selectedRunId === updatedRunId) {
        setIsLoadingDetail(true);
        settingsIpc.getAuditRunDetail(updatedRunId).then((detail) => {
          setSelectedRunEvents(detail);
        }).catch(console.error).finally(() => {
          setIsLoadingDetail(false);
        });
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [settingsIpc, selectedRunId, fetchRuns]);

  useEffect(() => {
    if (!selectedRunId) {
      Promise.resolve().then(() => {
        setSelectedRunEvents(null);
      });
      return;
    }

    Promise.resolve().then(() => {
      setIsLoadingDetail(true);
      settingsIpc
        .getAuditRunDetail(selectedRunId)
        .then((detail) => {
          setSelectedRunEvents(detail);
        })
        .catch((err) => {
          console.error(`Failed to fetch events for run ${selectedRunId}:`, err);
        })
        .finally(() => {
          setIsLoadingDetail(false);
        });
    });
  }, [selectedRunId, settingsIpc]);

  const selectedRunSummary = runs.find((r) => r.agentRunId === selectedRunId);

  return (
    <div className="flex flex-1 overflow-hidden h-full">
      {/* Left Pane - List of Runs */}
      <div className="w-80 border-r border-border bg-card flex flex-col h-full">
        <div className="p-4 border-b border-border flex items-center justify-between shrink-0">
          <h3 className="font-semibold text-sm">Run History</h3>
          <Button
            variant="ghost"
            size="icon"
            onClick={fetchRuns}
            disabled={isPending}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
          >
            <RotateCw className={`h-4 w-4 ${isPending ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-3 space-y-2">
            {runs.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-xs italic">
                No agent runs recorded yet.
              </div>
            ) : (
              runs.map((run) => {
                const isActive = selectedRunId === run.agentRunId;
                return (
                  <div
                    key={run.agentRunId}
                    onClick={() => setSelectedRunId(run.agentRunId)}
                    className={`p-3 rounded-lg border text-left cursor-pointer transition-all duration-150 ${
                      isActive
                        ? 'bg-secondary/40 border-primary/50 shadow-sm'
                        : 'bg-background hover:bg-muted/30 border-border/60 hover:border-border'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {formatTime(run.startedAt)} ({formatDate(run.startedAt)})
                      </span>
                      <StatusBadge status={run.status} />
                    </div>
                    <p className="text-xs font-medium text-foreground line-clamp-2 mb-2 select-none">
                      {run.transcript || <span className="italic text-muted-foreground/80">(Empty prompt)</span>}
                    </p>
                    {run.tools.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {run.tools.slice(0, 3).map((tool) => (
                          <span
                            key={tool}
                            className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[9px] font-mono text-muted-foreground border border-border/40"
                          >
                            {tool.split('.').pop()}
                          </span>
                        ))}
                        {run.tools.length > 3 && (
                          <span className="text-[9px] font-mono text-muted-foreground/75 px-1 py-0.5">
                            +{run.tools.length - 3} more
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Right Pane - Detail View */}
      <div className="flex-1 bg-background flex flex-col h-full min-w-0">
        {selectedRunId ? (
          <div className="flex flex-col h-full overflow-hidden">
            {/* Header info */}
            <div className="p-5 border-b border-border shrink-0">
              <div className="flex items-center justify-between gap-4 mb-2">
                <h3 className="font-semibold text-base truncate pr-4">Run Details</h3>
                {selectedRunSummary && <StatusBadge status={selectedRunSummary.status} size="lg" />}
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground font-mono">
                  ID: <span className="select-all">{selectedRunId}</span>
                </div>
                {selectedRunSummary && (
                  <div className="text-xs text-muted-foreground">
                    Started at {new Date(selectedRunSummary.startedAt).toLocaleString()}
                  </div>
                )}
              </div>
            </div>

            {/* Content pane */}
            <ScrollArea className="flex-1 min-h-0">
              <div className="p-6 space-y-6 max-w-3xl">
                {/* Prompt block */}
                <div className="space-y-1.5">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Voice Prompt</h4>
                  <div className="p-4 rounded-lg bg-secondary/20 border border-border/60 text-sm select-text leading-relaxed">
                    {selectedRunSummary?.transcript || <span className="italic text-muted-foreground">(No prompt recorded)</span>}
                  </div>
                </div>

                {/* Final Response (if present) */}
                {selectedRunSummary?.response && (
                  <div className="space-y-1.5">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Final Response</h4>
                    <div className="p-4 rounded-lg bg-primary-foreground border border-border text-sm select-text leading-relaxed whitespace-pre-wrap">
                      {selectedRunSummary.response}
                    </div>
                  </div>
                )}

                {/* Error Block (if failed) */}
                {selectedRunSummary?.error && (
                  <div className="space-y-1.5">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-destructive">Execution Failure</h4>
                    <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive select-text font-mono">
                      {selectedRunSummary.error}
                    </div>
                  </div>
                )}

                {/* Events Timeline */}
                <div className="space-y-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Execution Timeline</h4>
                  {isLoadingDetail && !selectedRunEvents ? (
                    <p className="text-xs text-muted-foreground italic">Loading events...</p>
                  ) : selectedRunEvents && selectedRunEvents.length > 0 ? (
                    <div className="relative pl-6 border-l border-border space-y-6">
                      {selectedRunEvents.map((event, index) => {
                        const isLast = index === selectedRunEvents.length - 1;
                        return (
                          <TimelineNode
                            key={event.id}
                            event={event}
                            isLast={isLast}
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground italic">No detailed timeline events found.</p>
                  )}
                </div>
              </div>
            </ScrollArea>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <Terminal className="h-8 w-8 text-muted-foreground/50 mb-3" />
            <h3 className="font-medium text-sm text-foreground">No Run Selected</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Select an agent run from the history list to inspect its execution.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// Sub-components & Helpers

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
  const isLg = size === 'lg';
  const baseClass = isLg ? 'px-2.5 py-0.5 text-xs' : 'px-1.5 py-0 text-[10px]';

  switch (status) {
    case 'completed':
      return (
        <Badge variant="outline" className={`${baseClass} border-emerald-500/30 bg-emerald-500/10 text-emerald-500`}>
          Completed
        </Badge>
      );
    case 'failed':
      return (
        <Badge variant="outline" className={`${baseClass} border-destructive/30 bg-destructive/10 text-destructive`}>
          Failed
        </Badge>
      );
    case 'cancelled':
      return (
        <Badge variant="outline" className={`${baseClass} border-muted-foreground/30 bg-muted/20 text-muted-foreground`}>
          Cancelled
        </Badge>
      );
    case 'interrupted':
      return (
        <Badge variant="outline" className={`${baseClass} border-amber-500/30 bg-amber-500/10 text-amber-500`}>
          Interrupted
        </Badge>
      );
    case 'running':
      return (
        <Badge
          variant="outline"
          className={`${baseClass} border-sky-500/30 bg-sky-500/10 text-sky-500 animate-pulse`}
        >
          Thinking
        </Badge>
      );
    default:
      return null;
  }
}

interface TimelineNodeProps {
  event: AuditEventDetail;
  isLast: boolean;
}

function TimelineNode({ event }: TimelineNodeProps) {
  const [showPayload, setShowPayload] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(event.payload, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy payload:', err);
    }
  };

  const info = getEventDisplayInfo(event);

  return (
    <div className="relative group">
      {/* Node Marker icon */}
      <span className="absolute -left-[37px] top-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background shadow-sm ring-4 ring-background">
        {info.icon}
      </span>

      {/* Main Node Content */}
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-semibold text-foreground">
            {info.title}
          </span>
          <span className="text-[10px] text-muted-foreground font-mono">
            {formatTime(event.createdAt)}
          </span>
        </div>
        <p className="text-xs text-muted-foreground select-text leading-relaxed">
          {info.description}
        </p>

        {/* Payload expander */}
        {hasPayload(event) && (
          <div className="pt-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowPayload(!showPayload)}
              className="h-6 px-1.5 text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40"
            >
              {showPayload ? (
                <>
                  <ChevronDown className="h-3 w-3 mr-1" />
                  Hide payload
                </>
              ) : (
                <>
                  <ChevronRight className="h-3 w-3 mr-1" />
                  View payload
                </>
              )}
            </Button>

            {showPayload && (
              <div className="relative mt-2 rounded-lg border border-border bg-muted/45 max-w-full">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleCopy}
                  className="absolute right-2 top-2 h-7 w-7 text-muted-foreground hover:text-foreground bg-background/50 hover:bg-background border border-border/40"
                  title="Copy JSON Payload"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
                <pre className="p-4 overflow-auto max-h-64 text-[11px] font-mono select-text leading-normal max-w-full text-foreground/90 whitespace-pre-wrap">
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
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
  icon: React.ReactNode;
}

function getEventDisplayInfo(event: AuditEventDetail): EventDisplay {
  const p = event.payload;

  switch (event.eventType) {
    case 'run_started':
      return {
        title: 'Run Started',
        description: `Agent initialized with prompt: "${p.transcript}"`,
        icon: <Play className="h-2.5 w-2.5 text-sky-500 fill-sky-500" />,
      };
    case 'status':
      return {
        title: 'Status Update',
        description: p.status || 'Agent status update',
        icon: <Clock className="h-2.5 w-2.5 text-muted-foreground" />,
      };
    case 'tool_requests': {
      const toolNames = Array.isArray(p.toolCalls)
        ? p.toolCalls.map((tc: any) => tc.toolName.split('__').join('.')).join(', ')
        : 'unknown tools';
      return {
        title: 'Tool Requested',
        description: `Model requested tool execution: ${toolNames}`,
        icon: <Terminal className="h-2.5 w-2.5 text-indigo-500" />,
      };
    }
    case 'tool_results': {
      const count = Array.isArray(p.toolResults) ? p.toolResults.length : 0;
      return {
        title: 'Tool Results Received',
        description: `Received outputs for ${count} tool(s)`,
        icon: <CheckCircle2 className="h-2.5 w-2.5 text-indigo-400" />,
      };
    }
    case 'approval_requested':
      return {
        title: 'Approval Required',
        description: `Sensitive tool requires user consent: ${p.serverId}.${p.toolName}`,
        icon: <AlertTriangle className="h-2.5 w-2.5 text-amber-500" />,
      };
    case 'approval_decision':
      return {
        title: 'Approval Choice',
        description: p.approved
          ? `User approved execution of ${p.serverId}.${p.toolName}`
          : `User denied tool execution: ${p.message || 'Deny'}`,
        icon: p.approved ? (
          <CheckCircle2 className="h-2.5 w-2.5 text-emerald-500" />
        ) : (
          <XCircle className="h-2.5 w-2.5 text-destructive" />
        ),
      };
    case 'mcp_tool_execute_started':
      return {
        title: 'Calling MCP Tool',
        description: `Executing tool ${p.serverId}.${p.toolName} on server`,
        icon: <Terminal className="h-2.5 w-2.5 text-purple-400" />,
      };
    case 'mcp_tool_execute_result':
      return {
        title: 'MCP Tool Success',
        description: `Finished executing ${p.serverId}.${p.toolName} successfully`,
        icon: <CheckCircle2 className="h-2.5 w-2.5 text-emerald-400" />,
      };
    case 'mcp_tool_execute_error':
      return {
        title: 'MCP Tool Error',
        description: `Execution failed for ${p.serverId}.${p.toolName}: ${p.error || 'Unknown error'}`,
        icon: <XCircle className="h-2.5 w-2.5 text-destructive" />,
      };
    case 'empty_response_degraded':
      return {
        title: 'Empty Response degraded',
        description: p.reason || 'Received an empty response from model',
        icon: <AlertTriangle className="h-2.5 w-2.5 text-amber-500" />,
      };
    case 'max_step_guardrail':
      return {
        title: 'Guardrail Warning',
        description: `Stop threshold hit (steps: ${p.stepCount})`,
        icon: <AlertTriangle className="h-2.5 w-2.5 text-destructive" />,
      };
    case 'run_completed':
      return {
        title: 'Run Completed',
        description: 'Agent finished reasoning and outputs are finalized.',
        icon: <CheckCircle2 className="h-2.5 w-2.5 text-emerald-500 fill-emerald-500" />,
      };
    case 'run_interrupted':
      return {
        title: 'Run Interrupted',
        description: `Run ended before normal completion. Reason: ${p.reason || 'interrupted'}`,
        icon: <XCircle className="h-2.5 w-2.5 text-muted-foreground" />,
      };
    case 'run_cancelled':
    case 'cancelled':
      return {
        title: 'Run Cancelled',
        description: `Run was aborted. Reason: ${p.reason || 'User requested cancellation'}`,
        icon: <XCircle className="h-2.5 w-2.5 text-muted-foreground" />,
      };
    case 'run_failed':
      return {
        title: 'Run Failed',
        description: `Execution failed: ${p.error || 'Unknown error'}`,
        icon: <XCircle className="h-2.5 w-2.5 text-destructive fill-destructive" />,
      };
    default:
      return {
        title: event.eventType.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        description: 'Audit log entry',
        icon: <Terminal className="h-2.5 w-2.5 text-muted-foreground" />,
      };
  }
}
