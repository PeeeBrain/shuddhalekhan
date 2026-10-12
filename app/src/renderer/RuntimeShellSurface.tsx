import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, Bot, Check, ShieldQuestion } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  AgentApprovalChoice,
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
          icon={Bot}
          title="Agent"
          live={{ role: 'status', 'aria-live': 'polite' }}
        >
          {isThinkingMessage(snapshot.message) ? <ThinkingDots /> : snapshot.message}
        </AgentCard>
      );
    case 'agent-streaming':
      return (
        <AgentCard
          tone="primary"
          icon={Bot}
          title="Agent"
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
          icon={Check}
          title="Agent · Done"
          live={{ role: 'status', 'aria-live': 'polite' }}
          growRef
          measureKey={snapshot.revision}
          actions={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => window.electronAPI?.send('runtime:agent-dismiss')}
            >
              Dismiss
            </Button>
          }
        >
          <div className="break-words">{renderMarkdown(snapshot.response)}</div>
          {snapshot.toolSummary.length > 0 ? (
            <p className="mt-3 break-words border-t border-border/60 pt-2.5 text-xs text-muted-foreground">
              Used {snapshot.toolSummary.slice(0, 3).join(' · ')}
            </p>
          ) : null}
        </AgentCard>
      );
    case 'agent-failed':
      return (
        <AgentCard
          tone="destructive"
          icon={AlertTriangle}
          title="Agent · Failed"
          live={{ role: 'alert' }}
          actions={
            <Button
              type="button"
              variant="ghost"
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
          className="m-0 max-h-12 w-[488px] overflow-hidden rounded-[14px] border border-border bg-card px-3.5 py-2.5 text-sm leading-5 text-foreground"
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
      <div className="flex h-10 w-40 items-center justify-center gap-2.5 rounded-[14px] border border-border bg-card text-primary">
        <span aria-hidden="true" className="processing-bars">
          <span className="processing-bar" />
          <span className="processing-bar" />
          <span className="processing-bar" />
          <span className="processing-bar" />
          <span className="processing-bar" />
        </span>
        <p className="text-xs font-medium text-muted-foreground">Transcribing…</p>
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
      className="flex h-screen w-screen flex-col overflow-hidden rounded-[14px] border border-destructive/40 bg-card text-card-foreground"
    >
      <IslandHeader icon={AlertTriangle} tone="destructive" title="Dictation" />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-3">
        <p className="text-sm leading-relaxed text-foreground">{snapshot.message}</p>
      </div>
      {snapshot.recoveryActions.length ? (
        <div className="flex flex-wrap justify-end gap-2 px-3 pb-3">
          {snapshot.recoveryActions.map((action) => (
            <Button
              key={action}
              type="button"
              variant={action === 'retry-paste' ? 'default' : 'ghost'}
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

const TONE_TEXT = {
  primary: 'text-agent-accent',
  warning: 'text-warning',
  success: 'text-success',
  destructive: 'text-destructive',
} as const;

type Tone = keyof typeof TONE_TEXT;

/** Shared island header: a tinted glyph tile names what the surface is about. */
function IslandHeader({ icon: Icon, tone, title, meta }: {
  icon: LucideIcon;
  tone: Tone;
  title: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2.5 px-3 pb-2 pt-3">
      <span aria-hidden="true" className={`flex size-6 shrink-0 bg-current/15 items-center justify-center rounded-[4px] ${TONE_TEXT[tone]}`}>
        <Icon className="size-3.5" />
      </span>
      <p className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">{title}</p>
      {meta}
    </div>
  );
}

/**
 * The agent island: Agent Mode's squarer shape and accent border, with a
 * tone-tinted glyph. Passive cards never take focus; interactive actions
 * accept deliberate clicks without activating Shuddhalekhan.
 */
function AgentCard({
  tone,
  icon,
  title,
  live,
  announcement,
  growRef,
  measureKey,
  actions,
  children,
}: {
  tone: Tone;
  icon: LucideIcon;
  title: string;
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
      className="agent-island flex h-screen w-screen flex-col overflow-hidden border text-card-foreground"
    >
      {announcement ? (
        <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
      ) : null}
      <IslandHeader icon={icon} tone={tone} title={title} />
      <div
        ref={bodyRef}
        className="min-h-0 flex-1 overflow-y-auto break-words px-4 pb-3.5 text-sm leading-relaxed text-foreground"
      >
        {children}
      </div>
      {actions ? (
        <div className="-mt-1.5 flex shrink-0 justify-end gap-2 px-3 pb-2.5">
          {actions}
        </div>
      ) : null}
    </main>
  );
}

function ApprovalView({ snapshot }: { snapshot: AgentApprovalSnapshot }) {
  // Remounted per approvalId via key; drafts persist across preemption in a
  // module-level store so denial feedback survives Dictation round-trips.
  const [message, setMessage] = useState(() => approvalDrafts.get(snapshot.approvalId) ?? '');
  const [submitting, setSubmitting] = useState(false);
  // Read once: the countdown is a stepped CSS animation, not a re-render loop.
  const [secondsLeft] = useState(() => Math.max(1, Math.ceil((new Date(snapshot.expiresAt).getTime() - Date.now()) / 1000)));
  const fields = describeArguments(snapshot.arguments);
  const server = snapshot.serverDisplayName || snapshot.serverId;

  const submitDecision = (decision: AgentApprovalChoice) => {
    if (submitting) return;
    setSubmitting(true);
    void window.electronAPI.invoke(
      'agent:approval-decision',
      snapshot.agentRunId,
      snapshot.approvalId,
      decision,
      decision === 'denied' ? message || undefined : undefined,
    ).catch(() => setSubmitting(false));
  };

  // Shortcuts apply once the user clicks into the card; the denial note and
  // focused buttons keep their native keys.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const tag = (event.target as HTMLElement).tagName;
    if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SUMMARY') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const decision = APPROVAL_SHORTCUTS[event.key.toLowerCase()];
    if (!decision) return;
    event.preventDefault();
    submitDecision(decision);
  };

  return (
    <main
      role="alert"
      data-tone="warning"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="agent-island relative flex h-screen w-screen flex-col overflow-hidden border text-card-foreground outline-none"
    >
      <span
        aria-hidden="true"
        className="approval-countdown absolute inset-x-0 top-0 h-0.5 origin-left bg-warning"
        style={{ animationDuration: `${secondsLeft}s`, animationTimingFunction: `steps(${secondsLeft})` }}
      />
      <IslandHeader
        icon={ShieldQuestion}
        tone="warning"
        title="Approval needed"
        meta={<p className="truncate font-mono text-[11px] text-muted-foreground">{server}:{snapshot.toolName}</p>}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-3">
        <h1 className="text-[15px] font-semibold leading-snug text-foreground">
          {humanize(snapshot.toolName)}
        </h1>

        {fields ? (
          <dl className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px] leading-5">
            {fields.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="truncate text-muted-foreground">{humanize(key)}</dt>
                <dd className="line-clamp-3 whitespace-pre-wrap break-words text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        <details className="text-xs" open={!fields}>
          <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
            Raw arguments
          </summary>
          <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-5 text-foreground/80">
            {formatArguments(snapshot.arguments)}
          </pre>
        </details>

        <Textarea
          value={message}
          onChange={(event) => {
            approvalDrafts.clear();
            approvalDrafts.set(snapshot.approvalId, event.target.value);
            setMessage(event.target.value);
          }}
          placeholder="Optional denial message"
          aria-label="Optional denial message"
          disabled={submitting}
          className="min-h-14 resize-none rounded-md border-border bg-background/60 text-xs leading-5 text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {submitting ? (
        <p role="status" aria-live="polite" className="shrink-0 px-4 pb-4 text-center text-xs font-medium text-muted-foreground">
          Feedback sent. Continuing…
        </p>
      ) : (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-border/60 px-3 py-2.5">
          <Button type="button" variant="ghost" size="sm" aria-keyshortcuts="A" onClick={() => submitDecision('always-allow')}>
            Always allow<Kbd>A</Kbd>
          </Button>
          <div className="flex-1" />
          <Button type="button" variant="secondary" size="sm" aria-keyshortcuts="Escape" onClick={() => submitDecision('denied')}>
            Deny<Kbd>Esc</Kbd>
          </Button>
          <Button type="button" size="sm" aria-keyshortcuts="Enter" onClick={() => submitDecision('approved')}>
            Approve<Kbd>↵</Kbd>
          </Button>
        </div>
      )}
    </main>
  );
}

const APPROVAL_SHORTCUTS: Partial<Record<string, AgentApprovalChoice>> = {
  enter: 'approved',
  escape: 'denied',
  a: 'always-allow',
};

function Kbd({ children }: { children: ReactNode }) {
  return <kbd aria-hidden="true" className="ml-1.5 font-sans text-[10px] font-normal opacity-60">{children}</kbd>;
}

/** Flat argument objects read as labeled fields; anything else stays raw only. */
function describeArguments(value: unknown): Array<[string, string]> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  return entries.map(([key, field]) => [
    key,
    typeof field === 'string' ? field : JSON.stringify(field) ?? String(field),
  ]);
}

/** send_message / sendMessage -> "Send message". */
function humanize(name: string): string {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
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
