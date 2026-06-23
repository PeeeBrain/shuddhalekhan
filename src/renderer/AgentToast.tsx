import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentToastState } from '../types/ipc';
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
          <span className="min-w-9 text-right text-xs font-bold uppercase tracking-wide text-warning">
            {secondsLeft}s
          </span>
        </div>

        <h1 className="mb-2 break-words text-base font-semibold leading-snug line-clamp-3">
          {state.serverId}:{state.toolName}
        </h1>

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
        {state.kind === 'completed' ? (
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

function renderMarkdown(markdown: string): ReactNode {
  const lines = markdown.split(/\r?\n/);
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (!line.trim()) {
      index++;
      continue;
    }

    if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = [];
      index++;
      while (index < lines.length && !(lines[index] ?? '').trimStart().startsWith('```')) {
        codeLines.push(lines[index] ?? '');
        index++;
      }
      if (index < lines.length) index++;
      nodes.push(
        <pre key={nodes.length} className="my-2 max-w-full overflow-auto rounded-md border border-border bg-muted p-2 text-xs leading-relaxed">
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      nodes.push(
        <p key={nodes.length} className="mb-1 mt-2 text-sm font-semibold first:mt-0">
          {renderInlineMarkdown(heading[2] ?? '')}
        </p>
      );
      index++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*[-*]\s+/, ''));
        index++;
      }
      nodes.push(
        <ul key={nodes.length} className="my-1.5 list-disc space-y-1 pl-4">
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*\d+\.\s+/, ''));
        index++;
      }
      nodes.push(
        <ol key={nodes.length} className="my-1.5 list-decimal space-y-1 pl-4">
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() &&
      !(lines[index] ?? '').trimStart().startsWith('```') &&
      !/^(#{1,3})\s+/.test(lines[index] ?? '') &&
      !/^\s*[-*]\s+/.test(lines[index] ?? '') &&
      !/^\s*\d+\.\s+/.test(lines[index] ?? '')
    ) {
      paragraphLines.push(lines[index] ?? '');
      index++;
    }

    nodes.push(
      <p key={nodes.length} className="my-1.5 whitespace-pre-wrap first:mt-0 last:mb-0">
        {renderInlineMarkdown(paragraphLines.join('\n'))}
      </p>
    );
  }

  return nodes.length > 0 ? nodes : <p className="m-0" />;
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(
        <code key={nodes.length} className="rounded bg-muted px-1 py-px text-xs text-primary">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={nodes.length} className="font-semibold text-foreground">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={nodes.length} className="italic">{token.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const href = link?.[2] ?? '#';
      nodes.push(
        <a key={nodes.length} href={href} className="text-primary underline underline-offset-2">
          {link?.[1] ?? token}
        </a>
      );
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}
