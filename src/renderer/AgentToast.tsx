import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentToastState } from '../types/ipc';
import { renderMarkdown } from './markdown';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';

export function AgentToast() {
  const [state, setState] = useState<AgentToastState | null>(null);
  const [message, setMessage] = useState('');
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const toastRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const remove = window.electronAPI?.on('agent-toast:update', (nextState) => {
      setState(nextState);
      setMessage('');
      setApprovalSubmitting(false);
    });

    const interval = window.setInterval(() => setNow(Date.now()), 500);

    return () => {
      remove?.();
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!state) return undefined;
    if (state.kind === 'approval' || state.kind === 'streaming') return undefined;

    const timer = window.setTimeout(() => {
      window.electronAPI?.send('agent-toast:dismiss');
    }, 6000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [state]);

  const secondsLeft = useMemo(() => {
    if (state?.kind !== 'approval') return null;
    return Math.max(0, Math.ceil((new Date(state.expiresAt).getTime() - now) / 1000));
  }, [now, state]);

  useLayoutEffect(() => {
    if (!state || (state.kind !== 'streaming' && state.kind !== 'completed')) return undefined;
    const element = toastRef.current;
    if (!element) return undefined;

    let frame = 0;
    const publishSize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const body = bodyRef.current;
        const measuredHeight = body
          ? element.scrollHeight - body.clientHeight + body.scrollHeight
          : element.scrollHeight;
        window.electronAPI?.send('agent-toast:content-size', measuredHeight);
      });
    };

    publishSize();
    const observer = new ResizeObserver(publishSize);
    observer.observe(element);
    if (bodyRef.current) observer.observe(bodyRef.current);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [state]);

  if (!state) return null;

  const accentColor = getAccentColor(state.kind);
  const liveAttrs = getLiveAttributes(state.kind);

  if (state.kind === 'approval') {
    const submitDecision = (decision: 'approved' | 'denied', denialMessage?: string) => {
      setApprovalSubmitting(true);
      setState({
        kind: 'status',
        agentRunId: state.agentRunId,
        message: decision === 'approved' ? 'Approval sent. Continuing…' : 'Feedback sent. Continuing…',
      });
      decide(state, decision, denialMessage);
    };

    const timerUrgent = secondsLeft !== null && secondsLeft <= 5;
    const timerClass = timerUrgent
      ? 'min-w-9 text-right text-xs font-bold uppercase tracking-wide text-destructive motion-safe:animate-pulse'
      : 'min-w-9 text-right text-xs font-bold uppercase tracking-wide text-warning';

    return (
      <main
        ref={toastRef}
        {...liveAttrs}
        className="flex h-screen w-screen flex-col overflow-hidden rounded-lg border border-border border-l-4 border-l-warning bg-card p-4 text-card-foreground shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <Badge variant="outline" className="border-transparent bg-transparent px-0 text-xs font-bold uppercase tracking-wide text-warning">
            Approval
          </Badge>
          <span className={timerClass}>
            {secondsLeft}s
          </span>
        </div>

        <h1 className="mb-1 break-words text-base font-semibold leading-snug line-clamp-3">
          {(state.serverDisplayName || state.serverId)}:{state.toolName}
        </h1>
        {state.serverDisplayName ? (
          <p className="mb-2 text-xs text-muted-foreground font-mono">
            {state.serverId}
          </p>
        ) : null}

        <p className="mb-2 block min-h-10 flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-2 text-sm leading-relaxed text-muted-foreground">
          {formatArguments(state.arguments)}
        </p>

        <Textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Optional denial message"
          aria-label="Optional denial message"
          className="h-9 min-h-0 flex-shrink-0 resize-none rounded-md border-border bg-background text-xs leading-4 text-foreground placeholder:text-muted-foreground"
        />

        <div className="mt-3 flex flex-shrink-0 justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8 w-24"
            disabled={approvalSubmitting}
            onClick={() => submitDecision('denied', message)}
          >
            Deny
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 w-24"
            disabled={approvalSubmitting}
            onClick={() => submitDecision('approved')}
          >
            Approve
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main
      ref={toastRef}
      {...liveAttrs}
      className={`flex h-screen w-screen flex-col overflow-hidden rounded-lg border border-border border-l-2 bg-card p-4 text-card-foreground shadow-lg ${accentColor}`}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <Badge variant="outline" className="border-transparent bg-transparent px-0 text-xs font-bold uppercase tracking-wide text-muted-foreground">
          {getTitle(state)}
        </Badge>
        {state.kind === 'completed' || state.kind === 'failed' || state.kind === 'cancelled' || state.kind === 'config' || state.kind === 'transcription-failed' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => window.electronAPI?.send('agent-toast:dismiss')}
          >
            Dismiss
          </Button>
        ) : null}
      </div>

      <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto break-words text-sm leading-relaxed text-muted-foreground">
        {state.kind === 'status' && isThinkingMessage(getBody(state))
          ? <ThinkingDots />
          : state.kind === 'streaming' || state.kind === 'completed'
            ? renderMarkdown(getBody(state))
            : <p className="m-0 whitespace-pre-wrap">{getBody(state)}</p>}
      </div>

      {state.kind === 'completed' && state.toolSummary.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-1.5 p-0">
          {state.toolSummary.slice(0, 3).map((item) => (
            <li key={item} className="max-w-full rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground break-words">
              {item}
            </li>
          ))}
        </ul>
      ) : null}

      {state.kind === 'config' || state.kind === 'transcription-failed' ? (
        <div className="mt-3 flex-shrink-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => window.electronAPI?.invoke('settings:open')}
          >
            Open Settings
          </Button>
        </div>
      ) : null}
    </main>
  );
}

function isThinkingMessage(message: string): boolean {
  return /^thinking/i.test(message);
}

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-label="Thinking" role="status">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="motion-safe:animate-thinking-dot inline-block h-[5px] w-[5px] rounded-full bg-current opacity-20"
          style={{ animationDelay: `${i * 0.2}s` }}
        />
      ))}
    </span>
  );
}

function getAccentColor(kind: AgentToastState['kind']): string {
  switch (kind) {
    case 'status':
    case 'streaming':
      return 'border-l-primary';
    case 'completed':
      return 'border-l-success';
    case 'failed':
    case 'cancelled':
    case 'transcription-failed':
      return 'border-l-destructive';
    case 'config':
      return 'border-l-muted-foreground';
    default:
      return 'border-l-border';
  }
}

function getLiveAttributes(kind: AgentToastState['kind']): { role?: 'alert'; 'aria-live'?: 'polite' } {
  switch (kind) {
    case 'approval':
    case 'failed':
    case 'cancelled':
    case 'config':
    case 'transcription-failed':
      return { role: 'alert' };
    case 'status':
    case 'streaming':
    case 'completed':
      return { 'aria-live': 'polite' };
    default:
      return { 'aria-live': 'polite' };
  }
}

function decide(state: Extract<AgentToastState, { kind: 'approval' }>, decision: 'approved' | 'denied', message?: string): void {
  void window.electronAPI?.invoke('agent:approval-decision', state.agentRunId, state.approvalId, decision, message);
}

function getTitle(state: AgentToastState): string {
  switch (state.kind) {
    case 'status':
      return 'Agent';
    case 'streaming':
      return 'Agent';
    case 'completed':
      return 'Complete';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'config':
      return 'Agent Setup';
    case 'transcription-failed':
      return 'Transcription failed';
    case 'approval':
      return 'Approval';
  }
}

function getBody(state: Exclude<AgentToastState, { kind: 'approval' }>): string {
  switch (state.kind) {
    case 'status':
      return state.message;
    case 'streaming':
      return state.response;
    case 'completed':
      return state.response;
    case 'failed':
      return state.error;
    case 'cancelled':
      return 'Agent run cancelled.';
    case 'config':
    case 'transcription-failed':
      return state.message;
  }
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

