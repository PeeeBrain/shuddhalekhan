import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  DictationRecoveryAction,
  RuntimePresentationSnapshot,
} from '../types/ipc';
import { Button } from './components/ui/button';
import { Textarea } from './components/ui/textarea';
import { RecordingPopup } from './RecordingPopup';
import { renderMarkdown } from './markdown';

const ACTION_LABELS: Record<DictationRecoveryAction, string> = {
  'retry-paste': 'Retry Paste',
  'copy-full-transcript': 'Copy Full Transcript',
  'copy-partial-transcript': 'Copy Partial Transcript',
};

type AgentApprovalSnapshot = Extract<RuntimePresentationSnapshot, { kind: 'agent-approval' }>;

/** Drafts survive Dictation preemption round-trips within one shell lifetime. */
const approvalDrafts = new Map<string, string>();

export function RuntimeShellSurface() {
  const [snapshot, setSnapshot] = useState<RuntimePresentationSnapshot | null>(null);
  const [retrying, setRetrying] = useState(false);
  const latest = useRef({ generation: 0, revision: 0 });

  useEffect(() => window.electronAPI.subscribe('runtime:snapshot', (next) => {
    const current = latest.current;
    if (
      next.generation < current.generation
      || (next.generation === current.generation && next.revision <= current.revision)
    ) return;
    latest.current = { generation: next.generation, revision: next.revision };
    if (next.kind === 'failure') setRetrying(false);
    setSnapshot(next);
  }), []);

  if (!snapshot || snapshot.kind === 'idle') return null;

  switch (snapshot.kind) {
    case 'recording':
      return <RecordingView snapshot={snapshot} />;
    case 'processing':
      return <ProcessingView />;
    case 'failure':
      return <FailureView snapshot={snapshot} retrying={retrying} setRetrying={setRetrying} />;
    case 'agent-status':
      return (
        <AgentCard tone="primary" kicker="Agent" live={{ role: 'status', 'aria-live': 'polite' }}>
          {isThinkingMessage(snapshot.message) ? <ThinkingDots /> : snapshot.message}
        </AgentCard>
      );
    case 'agent-streaming':
      return (
        <AgentCard
          tone="primary"
          kicker="Agent"
          live={undefined}
          announcement="Agent response is streaming"
          growRef
          measureKey={snapshot.revision}
        >
          <div aria-live="off" className="break-words">
            {renderMarkdown(snapshot.response)}
          </div>
        </AgentCard>
      );
    case 'agent-completed':
      return (
        <AgentCard
          tone="success"
          kicker="Complete"
          live={{ role: 'status', 'aria-live': 'polite' }}
          growRef
          measureKey={snapshot.revision}
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.electronAPI?.send('runtime:agent-dismiss')}
            >
              Dismiss
            </Button>
          }
        >
          <div className="break-words">{renderMarkdown(snapshot.response)}</div>
          {snapshot.toolSummary.length > 0 ? (
            <ul className="mt-3 flex flex-wrap gap-1.5 p-0">
              {snapshot.toolSummary.slice(0, 3).map((item) => (
                <li
                  key={item}
                  className="max-w-full rounded-full border border-border bg-muted px-2 py-0.5 text-xs break-words text-muted-foreground"
                >
                  {item}
                </li>
              ))}
            </ul>
          ) : null}
        </AgentCard>
      );
    case 'agent-failed':
      return (
        <AgentCard
          tone="destructive"
          kicker="Failed"
          live={{ role: 'alert' }}
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.electronAPI?.send('runtime:agent-dismiss')}
            >
              Dismiss
            </Button>
          }
        >
          {snapshot.message}
        </AgentCard>
      );
    case 'agent-approval':
      return <ApprovalView key={snapshot.approvalId} snapshot={snapshot} />;
    default: {
      const _exhaustive: never = snapshot;
      return _exhaustive;
    }
  }
}

function RecordingView({ snapshot }: { snapshot: Extract<RuntimePresentationSnapshot, { kind: 'recording' }> }) {
  const committed = snapshot.committed ?? '';
  const tentative = snapshot.tentative ?? '';
  const tentativeSuffix = tentative.startsWith(committed)
    ? tentative.slice(committed.length)
    : tentative;
  const hasPreview = committed.length > 0 || tentativeSuffix.length > 0 || snapshot.insertionHalted;

  return (
    <main className="flex h-screen w-screen flex-col items-center justify-center gap-2 overflow-hidden bg-transparent">
      <div className="h-[52px] w-[172px] shrink-0">
        <RecordingPopup
          key={snapshot.recordingSessionId}
          initialMode={snapshot.intent}
          recordingSessionId={snapshot.recordingSessionId}
        />
      </div>
      {hasPreview ? (
        <p
          data-testid="streaming-preview"
          aria-live="off"
          className="m-0 max-h-12 w-[488px] overflow-hidden rounded-lg border border-white/10 bg-[rgba(20,20,23,0.96)] px-3 py-2 text-sm leading-5 shadow-lg"
        >
          {snapshot.insertionHalted ? (
            <span data-testid="insertion-halted" className="mb-1 block text-xs font-medium text-amber-300">
              Insertion stopped — recording continues
            </span>
          ) : null}
          <span data-testid="streaming-committed" className="text-white/90">
            {committed}
          </span>
          <span data-testid="streaming-tentative" className="text-white/45">
            {tentativeSuffix}
          </span>
        </p>
      ) : null}
    </main>
  );
}

function ProcessingView() {
  return (
    <main
      role="status"
      aria-label="Processing transcription"
      aria-live="polite"
      className="flex h-screen w-screen items-center justify-center bg-transparent"
    >
      <div
        className="flex h-10 w-40 items-center justify-center gap-2 rounded-full border border-[rgba(133,146,255,0.42)] text-[11px] font-medium text-white/70 shadow-[inset_0_0_14px_rgba(100,108,255,0.16),inset_0_0_28px_rgba(100,108,255,0.06)]"
        style={{ background: 'rgba(20, 20, 23, 0.96)' }}
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full bg-[#8592ff] shadow-[0_0_6px_rgba(133,146,255,0.65)]"
        />
        <span>Processing…</span>
      </div>
    </main>
  );
}

function FailureView({
  snapshot,
  retrying,
  setRetrying,
}: {
  snapshot: Extract<RuntimePresentationSnapshot, { kind: 'failure' }>;
  retrying: boolean;
  setRetrying: (value: boolean) => void;
}) {
  return (
    <main role="alert" className="flex h-screen w-screen flex-col rounded-lg border border-border border-l-4 border-l-destructive bg-card p-4 text-card-foreground shadow-xl">
      <h1 className="text-sm font-semibold">Dictation needs attention</h1>
      <p className="mt-2 flex-1 overflow-auto text-sm text-muted-foreground">{snapshot.message}</p>
      {snapshot.recoveryActions.length ? (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {snapshot.recoveryActions.map((action) => (
            <Button
              key={action}
              type="button"
              variant={action === 'retry-paste' ? 'default' : 'outline'}
              size="sm"
              disabled={retrying && action === 'retry-paste'}
              onClick={() => {
                if (action === 'retry-paste') setRetrying(true);
                window.electronAPI.send('runtime:recovery-action', action);
              }}
            >
              {action === 'retry-paste' && retrying ? 'Retrying...' : ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      ) : null}
    </main>
  );
}

/**
 * One quiet card with a semantic left accent. Passive cards never take focus;
 * interactive actions accept deliberate clicks without activating Shuddhalekhan.
 */
function AgentCard({
  tone,
  kicker,
  live,
  announcement,
  growRef,
  measureKey,
  actions,
  children,
}: {
  tone: 'primary' | 'warning' | 'success' | 'destructive';
  kicker: string;
  live?: { role?: 'alert' | 'status'; 'aria-live'?: 'polite' };
  /** Polite one-shot announcement used instead of live regions for token streams. */
  announcement?: string;
  /** Reports natural content height so main can grow the window within its clamp. */
  growRef?: boolean;
  /** Changing this re-measures; stream deltas arrive as new revisions. */
  measureKey?: number;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const cardRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const publishSize = () => {
    const card = cardRef.current;
    if (!card) return;
    const body = bodyRef.current;
    // The scrollable body absorbs overflow, so chrome height must be added
    // from the card box while content height comes from the body scroll box.
    const measuredHeight = body
      ? card.scrollHeight - body.clientHeight + body.scrollHeight
      : card.scrollHeight;
    window.electronAPI?.send('runtime:agent-card-size', measuredHeight);
  };

  useLayoutEffect(() => {
    if (!growRef) return undefined;
    let frame = 0;
    frame = window.requestAnimationFrame(publishSize);
    return () => window.cancelAnimationFrame(frame);
  }, [growRef, measureKey]);

  useEffect(() => {
    if (!growRef) return undefined;
    const card = cardRef.current;
    const body = bodyRef.current;
    if (!card || !body) return undefined;
    let frame = 0;
    const schedulePublish = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(publishSize);
    };
    // Window-driven size changes resize the card box; observe both so
    // clamped growth and later shrinks keep the report current.
    const observer = new ResizeObserver(schedulePublish);
    observer.observe(card);
    observer.observe(body);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [growRef]);

  return (
    <main
      ref={cardRef}
      {...live}
      className={`flex h-screen w-screen flex-col overflow-hidden rounded-lg border border-border border-l-4 bg-card p-4 text-card-foreground shadow-xl ${toneClass[tone]}`}
    >
      {announcement ? (
        <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
      ) : null}
      <header className="mb-3 flex min-h-[10px] items-center justify-between gap-3">
        <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{kicker}</span>
      </header>
      <div
        ref={bodyRef}
        className="min-h-0 flex-1 overflow-y-auto break-words text-sm leading-relaxed text-muted-foreground"
      >
        {children}
      </div>
      {actions ? (
        <div className="mt-3 flex flex-shrink-0 justify-end gap-2 border-t border-border/60 pt-3">
          {actions}
        </div>
      ) : null}
    </main>
  );
}

const toneClass = {
  primary: 'border-l-primary',
  warning: 'border-l-warning',
  success: 'border-l-success',
  destructive: 'border-l-destructive',
} as const;

function ApprovalView({ snapshot }: { snapshot: AgentApprovalSnapshot }) {
  // Remounted per approvalId via key; drafts persist across preemption in a
  // module-level store so denial feedback survives Dictation round-trips.
  const [message, setMessage] = useState(() => approvalDrafts.get(snapshot.approvalId) ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Countdown ticks only while the approval is presented.
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(interval);
  }, []);

  const secondsLeft = Math.max(0, Math.ceil((new Date(snapshot.expiresAt).getTime() - now) / 1000));
  const timerUrgent = secondsLeft <= 5;

  const submitDecision = (decision: 'approved' | 'denied') => {
    setSubmitting(true);
    void window.electronAPI.invoke(
      'agent:approval-decision',
      snapshot.agentRunId,
      snapshot.approvalId,
      decision,
      decision === 'denied' ? message || undefined : undefined,
    ).catch(() => setSubmitting(false));
  };

  return (
    <main
      role="alert"
      className="flex h-screen w-screen flex-col overflow-hidden rounded-lg border border-border border-l-4 border-l-warning bg-card p-4 text-card-foreground shadow-xl"
    >
      <header className="mb-3 flex items-center justify-between gap-3">
        <span className="text-xs font-bold uppercase tracking-wide text-warning">Approval</span>
        <span
          className={
            timerUrgent
              ? 'min-w-9 text-right text-xs font-bold uppercase tracking-wide text-destructive'
              : 'min-w-9 text-right text-xs font-bold uppercase tracking-wide text-warning'
          }
        >
          {secondsLeft}s
        </span>
      </header>

      <h1 className="mb-1 break-words text-base font-semibold leading-snug line-clamp-3">
        {(snapshot.serverDisplayName || snapshot.serverId)}:{snapshot.toolName}
      </h1>
      {snapshot.serverDisplayName ? (
        <p className="mb-2 font-mono text-xs text-muted-foreground">{snapshot.serverId}</p>
      ) : null}

      <p className="mb-2 block min-h-10 flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-2 text-sm leading-relaxed text-muted-foreground">
        {formatArguments(snapshot.arguments)}
      </p>

      <Textarea
        value={message}
        onChange={(event) => {
          // Only the current approval's draft has any future; prune the rest.
          approvalDrafts.clear();
          approvalDrafts.set(snapshot.approvalId, event.target.value);
          setMessage(event.target.value);
        }}
        placeholder="Optional denial message"
        aria-label="Optional denial message"
        disabled={submitting}
        className="h-9 min-h-0 flex-shrink-0 resize-none rounded-md border-border bg-background text-xs leading-4 text-foreground placeholder:text-muted-foreground"
      />

      {submitting ? (
        <p role="status" aria-live="polite" className="mt-3 text-right text-xs text-muted-foreground">
          Feedback sent. Continuing…
        </p>
      ) : (
        <div className="mt-3 flex flex-shrink-0 justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8 w-24"
            onClick={() => submitDecision('denied')}
          >
            Deny
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 w-24"
            onClick={() => submitDecision('approved')}
          >
            Approve
          </Button>
        </div>
      )}
    </main>
  );
}

function isThinkingMessage(message: string): boolean {
  return /^thinking/i.test(message);
}

function ThinkingDots() {
  return (
    <span>
      <span className="sr-only">Thinking</span>
      <span aria-hidden="true" className="inline-flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="motion-safe:animate-thinking-dot inline-block h-[5px] w-[5px] rounded-full bg-current opacity-20"
            style={{ animationDelay: `${i * 0.2}s` }}
          />
        ))}
      </span>
    </span>
  );
}

function formatArguments(value: unknown): string {
  if (value === null || value === undefined) return 'No arguments.';
  if (typeof value === 'string') return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
