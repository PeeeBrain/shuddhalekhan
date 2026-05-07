import { useEffect, useMemo, useState } from 'react';
import type { AgentToastState } from '../types/ipc';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';

export function AgentToast() {
  const [state, setState] = useState<AgentToastState | null>(null);
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const remove = window.electronAPI?.on('agent-toast:update', (nextState) => {
      setState(nextState);
      setMessage('');
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

  if (!state) return null;

  if (state.kind === 'approval') {
    return (
      <main className="relative flex h-screen w-screen flex-col overflow-hidden rounded-[10px] border border-white/10 bg-[#111416] p-4 text-[#f8fafb] shadow-[0_22px_70px_rgba(0,0,0,0.48)]"
        style={{ background: 'linear-gradient(135deg, rgba(255,106,106,0.18), rgba(241,199,91,0.08)), #111416' }}>
        <div className="pointer-events-none fixed inset-0"
          style={{
            background: 'linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px)',
            backgroundSize: '18px 18px',
            maskImage: 'linear-gradient(135deg, black, transparent 68%)',
          }} />

        <div className="relative mb-2.5 flex items-center justify-between gap-3">
          <Badge variant="outline" className="border-transparent bg-transparent px-0 text-[11px] font-extrabold uppercase tracking-normal text-[#ffb2a6]">
            Approval
          </Badge>
          <span className="min-w-[36px] text-right text-[11px] font-extrabold uppercase tracking-normal text-[#f1d38a]">
            {secondsLeft}s
          </span>
        </div>

        <h1 className="relative mb-2 break-words text-base font-bold leading-[21px] text-white line-clamp-3">
          {state.serverId}:{state.toolName}
        </h1>

        <p className="relative mb-2 block min-h-[42px] flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-white/10 bg-black/35 p-2 text-[13px] leading-[18px] text-[#d9dee2]">
          {formatArguments(state.arguments)}
        </p>

        <Textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Optional denial message"
          aria-label="Optional denial message"
          className="relative h-9 min-h-0 flex-shrink-0 resize-none rounded-md border-white/15 bg-black/60 py-[7px] text-xs leading-4 text-[#f4f7f8] placeholder:text-muted-foreground focus-visible:border-[rgba(241,199,91,0.74)] focus-visible:ring-[rgba(241,199,91,0.13)]"
        />

        <div className="relative mt-2 flex flex-shrink-0 justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-[34px] w-24 bg-[#242a30] text-[#e8edf2] hover:bg-[#2a3138]"
            onClick={() => decide(state, 'denied', message)}
          >
            Deny
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-[34px] w-24"
            onClick={() => decide(state, 'approved')}
          >
            Approve
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className={`relative flex h-screen w-screen flex-col overflow-hidden rounded-[10px] border border-white/10 bg-[#111416] p-4 text-[#f8fafb] shadow-[0_22px_70px_rgba(0,0,0,0.48)] ${state.kind}`}
      style={state.kind === 'failed' || state.kind === 'cancelled'
        ? { background: 'linear-gradient(135deg, rgba(255,106,106,0.18), rgba(241,199,91,0.08)), #111416' }
        : undefined}>
      <div className="pointer-events-none fixed inset-0"
        style={{
          background: 'linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px)',
          backgroundSize: '18px 18px',
          maskImage: 'linear-gradient(135deg, black, transparent 68%)',
        }} />

      <div className="relative mb-2.5 flex items-center justify-between gap-3">
        <Badge variant="outline" className="border-transparent bg-transparent px-0 text-[11px] font-extrabold uppercase tracking-normal text-[#ffb2a6]">
          {getTitle(state)}
        </Badge>
      </div>

      <p className="relative m-0 line-clamp-4 overflow-hidden break-words text-[13px] leading-[18px] text-[#d9dee2]">
        {getBody(state)}
      </p>

      {state.kind === 'completed' && state.toolSummary.length > 0 ? (
        <ul className="relative mt-3 flex flex-wrap gap-1.5 p-0">
          {state.toolSummary.slice(0, 3).map((item) => (
            <li key={item} className="max-w-full rounded-full border border-white/10 bg-white/[0.06] px-[7px] py-[3px] text-[11px] leading-[15px] text-[#cad2da] break-words">
              {item}
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}

function decide(state: Extract<AgentToastState, { kind: 'approval' }>, decision: 'approved' | 'denied', message?: string): void {
  void window.electronAPI?.invoke('agent:approval-decision', state.agentRunId, state.approvalId, decision, message);
}

function getTitle(state: AgentToastState): string {
  switch (state.kind) {
    case 'status':
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
