import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
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
        <AgentCard
          tone="primary"
          live={{ role: 'status', 'aria-live': 'polite' }}
        >
          {isThinkingMessage(snapshot.message) ? <ThinkingDots /> : snapshot.message}
        </AgentCard>
      );
    case 'agent-streaming':
      return (
        <AgentCard
          tone="primary"
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
            <div className="mt-4 border-t border-border/60 pt-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Tool activity</p>
              <ul className="flex flex-wrap gap-1.5 p-0">
                {snapshot.toolSummary.slice(0, 3).map((item) => (
                  <li
                    key={item}
                    className="max-w-full break-words rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </AgentCard>
      );
    case 'agent-failed':
      return (
        <AgentCard
          tone="destructive"
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
    <main className="flex h-screen w-screen flex-col items-center justify-center gap-3 overflow-hidden bg-transparent">
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
          className="m-0 max-h-12 w-[488px] overflow-hidden rounded-lg border border-border/70 bg-card px-3.5 py-2.5 text-sm leading-5 text-foreground"
        >
          {snapshot.insertionHalted ? (
            <span data-testid="insertion-halted" className="mb-1 block text-xs font-semibold text-warning">
              Insertion stopped — recording continues
            </span>
          ) : null}
          <span data-testid="streaming-committed" className="text-foreground">
            {committed}
          </span>
          <span data-testid="streaming-tentative" className="text-muted-foreground">
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
      <div className="flex h-10 w-40 items-center justify-center gap-2 rounded-full border border-border bg-card text-primary">
        <span aria-hidden="true" className="processing-bars">
          <span className="processing-bar" />
          <span className="processing-bar" />
          <span className="processing-bar" />
          <span className="processing-bar" />
          <span className="processing-bar" />
        </span>
        <p className="text-xs font-medium tracking-wide">Processing…</p>
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
    <main
      role="alert"
      data-tone="destructive"
      className="flex h-screen w-screen flex-col overflow-hidden rounded-lg border border-border/40 border-l-2 border-l-destructive bg-card text-card-foreground"
    >
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        <p className="text-sm leading-relaxed text-foreground">{snapshot.message}</p>
      </div>
      {snapshot.recoveryActions.length ? (
        <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 px-4 pb-3 pt-3">
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
  live,
  announcement,
  growRef,
  measureKey,
  actions,
  children,
}: {
  tone: 'primary' | 'warning' | 'success' | 'destructive';
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
      data-tone={tone}
      className={`flex h-screen w-screen flex-col overflow-hidden rounded-lg border border-border/40 border-l-2 bg-card text-card-foreground ${toneClass[tone]}`}
    >
      {announcement ? (
        <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
      ) : null}
      <div
        ref={bodyRef}
        className="min-h-0 flex-1 overflow-y-auto break-words px-4 py-4 text-sm leading-relaxed text-foreground"
      >
        {children}
      </div>
      {actions ? (
        <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 px-4 pb-3 pt-3">
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
  const feedbackId = useId();

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
      data-tone="warning"
      className="flex h-screen w-screen flex-col overflow-hidden rounded-lg border border-border/40 border-l-2 border-l-warning bg-card text-card-foreground"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
        <h1 className="text-sm font-semibold leading-snug text-foreground">Approval required</h1>
        <p
          className={
            timerUrgent
              ? 'text-right text-xs font-medium tabular-nums text-destructive'
              : 'text-right text-xs font-medium tabular-nums text-warning'
          }
        >
          {secondsLeft}s
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Requested action</p>
          <h2 className="break-words text-sm font-semibold leading-snug text-foreground">
            {(snapshot.serverDisplayName || snapshot.serverId)}:{snapshot.toolName}
          </h2>
          {snapshot.serverDisplayName ? (
            <p className="break-words font-mono text-xs text-muted-foreground">{snapshot.serverId}</p>
          ) : null}
        </div>

        <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
          <p className="text-[11px] font-medium text-muted-foreground">Arguments</p>
          <p className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground/80">
            {formatArguments(snapshot.arguments)}
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={feedbackId} className="block text-xs font-medium text-foreground">
            Optional denial message
          </label>
          <Textarea
            id={feedbackId}
            value={message}
            onChange={(event) => {
              approvalDrafts.clear();
              approvalDrafts.set(snapshot.approvalId, event.target.value);
              setMessage(event.target.value);
            }}
            placeholder="Optional denial message"
            aria-label="Optional denial message"
            disabled={submitting}
            className="min-h-16 resize-none rounded-lg border-border bg-background text-xs leading-5 text-foreground placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {submitting ? (
        <p role="status" aria-live="polite" className="shrink-0 px-4 pb-4 text-center text-xs font-medium text-muted-foreground">
          Feedback sent. Continuing…
        </p>
      ) : (
        <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 px-4 pb-3 pt-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-9 w-24"
            onClick={() => submitDecision('denied')}
          >
            Deny
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-9 w-24"
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
