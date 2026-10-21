import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useInView, useReducedMotion } from 'motion/react';
import { Ban, Check, RotateCcw, ShieldQuestion } from 'lucide-react';
import { Reveal } from '@/components/motion/Reveal';
import { RecordingPill } from '@/components/landing/Pill';
import { cn } from '@/lib/utils';

type Policy = 'disabled' | 'alwaysAsk' | 'alwaysAllow';
type Run = {
  phase: 'listening' | 'working' | 'approval' | 'done';
  completed: number;
  result: 'opened' | 'denied' | 'disabled' | null;
};

const POLICIES: { id: Policy; label: string; note: string }[] = [
  { id: 'disabled', label: 'Disabled', note: 'The agent never sees this tool.' },
  { id: 'alwaysAsk', label: 'Always ask', note: 'The run stops and waits for your answer. New tools get this setting.' },
  { id: 'alwaysAllow', label: 'Always allow', note: 'The tool runs without asking. The audit log still records each call.' },
];

const STEPS = [
  { label: "Read this week's commits", tool: 'git:log' },
  { label: 'Draft the release notes', tool: 'notes:write' },
  { label: 'Open the pull request', tool: 'github:create_pull' },
];

const RESULTS = {
  opened: 'Drafted the release notes and opened pull request #214 against main.',
  denied: 'Drafted the release notes. You denied github:create_pull, so no pull request was opened.',
  disabled: 'Drafted the release notes. Opening a pull request needs github:create_pull, which is disabled.',
};

const START: Run = { phase: 'listening', completed: 0, result: null };
const SPRING = { type: 'spring', bounce: 0, duration: 0.35 } as const;

/** The next scripted state, or null when the run is waiting on the visitor or finished. */
function advance(run: Run, policy: Policy): Run | null {
  if (run.phase === 'listening') return { ...run, phase: 'working' };
  if (run.phase !== 'working') return null;
  if (run.completed === 2) return { phase: 'done', completed: 3, result: 'opened' };
  const completed = run.completed + 1;
  if (completed === 2 && policy === 'disabled') return { phase: 'done', completed, result: 'disabled' };
  if (completed === 2 && policy === 'alwaysAsk') return { phase: 'approval', completed, result: null };
  return { ...run, completed };
}

export function AgentSection() {
  const reduceMotion = useReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);
  const inView = useInView(stageRef, { once: true, amount: 0.4 });
  const [policy, setPolicy] = useState<Policy>('alwaysAsk');
  const [run, setRun] = useState<Run>(START);
  const [seconds, setSeconds] = useState(1);

  useEffect(() => {
    if (!inView) return undefined;
    const next = advance(run, policy);
    if (!next) return undefined;
    const timeout = setTimeout(() => setRun(next), run.phase === 'listening' ? 2200 : 1100);
    return () => clearTimeout(timeout);
  }, [inView, policy, run]);

  useEffect(() => {
    if (!inView || run.phase !== 'listening') return undefined;
    const interval = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [inView, run.phase]);

  const restart = (nextPolicy = policy) => {
    setPolicy(nextPolicy);
    setSeconds(1);
    setRun(START);
  };

  const decide = (choice: 'approved' | 'denied' | 'always-allow') => {
    if (choice === 'always-allow') setPolicy('alwaysAllow');
    setRun(choice === 'denied' ? { phase: 'done', completed: 2, result: 'denied' } : { phase: 'working', completed: 2, result: null });
  };

  const status =
    run.phase === 'listening' ? 'Listening'
    : run.phase === 'working' ? 'Working'
    : run.phase === 'approval' ? 'Waiting for approval'
    : run.result === 'opened' ? 'Done'
    : 'Done, one step skipped';

  const enterFromBelow = reduceMotion
    ? { initial: false as const, exit: { opacity: 0, transition: { duration: 0 } } }
    : { initial: { opacity: 0, y: 12 }, exit: { opacity: 0, y: 12, transition: { duration: 0.15, ease: 'easeIn' as const } } };

  return (
    <section id="agent-mode" className="scroll-mt-20 py-24 md:py-36">
      <div className="mx-auto grid max-w-6xl gap-x-16 gap-y-12 px-6 lg:grid-cols-12">
        <Reveal className="lg:col-span-5">
          <p className="text-[15px] font-medium text-agent">Agent Mode</p>
          <h2 className="mt-5 font-display text-[clamp(2.25rem,1.5rem+2.8vw,3.75rem)] leading-[1.02] font-semibold tracking-[-0.035em] text-balance">
            Delegate one-off tasks to agents.
          </h2>
          <p className="mt-6 max-w-[44ch] text-[17px] leading-relaxed text-muted-foreground text-pretty">
            Press the Agent Mode shortcut and say what you want done. The agent uses the model provider you set up and calls
            tools from the MCP servers you connect. Each command is a separate run with no chat history.
          </p>

          <div className="mt-10">
            <p id="policy-label" className="text-[13px] font-medium">
              Policy for <code className="font-mono text-[12px] text-muted-foreground">github:create_pull</code>
            </p>
            <div role="group" aria-labelledby="policy-label" className="mt-3 inline-flex rounded-[10px] border border-border bg-card p-1">
              {POLICIES.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={policy === id}
                  onClick={() => restart(id)}
                  className={cn(
                    'relative h-8 cursor-pointer rounded-md px-3.5 text-[13px] font-medium transition-colors duration-150 active:scale-[0.97]',
                    policy === id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {policy === id && (
                    <motion.span layoutId="policy-thumb" transition={reduceMotion ? { duration: 0 } : SPRING} className="absolute inset-0 rounded-md bg-raised" />
                  )}
                  <span className="relative">{label}</span>
                </button>
              ))}
            </div>
            <p className="mt-3 min-h-5 text-[13px] text-muted-foreground">{POLICIES.find((p) => p.id === policy)?.note}</p>
          </div>
        </Reveal>

        <Reveal delay={0.08} className="lg:col-span-7">
          <div ref={stageRef} className="flex min-h-[29rem] flex-col rounded-[20px] border border-border bg-canvas p-5 sm:p-8">
            <div className="flex items-center justify-between text-[13px]">
              <span className="text-muted-foreground" aria-live="polite">
                Agent run <span className="mx-1.5 text-border">/</span>
                <span className={cn(run.phase === 'approval' ? 'text-warning' : run.phase === 'done' ? 'text-success' : 'text-foreground')}>
                  {status}
                </span>
              </span>
              {run.phase === 'done' && (
                <button
                  type="button"
                  onClick={() => restart()}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 font-medium text-voice transition-colors duration-150 hover:bg-raised active:scale-[0.97]"
                >
                  <RotateCcw className="size-3.5" aria-hidden="true" /> Run again
                </button>
              )}
            </div>

            <p className={cn('mt-6 text-[19px] leading-snug text-pretty transition-opacity duration-200', run.phase === 'listening' && 'opacity-0')}>
              "Draft release notes from this week's commits and open a pull request."
            </p>

            <ol className="mt-7 space-y-3.5 border-t border-border/70 pt-6">
              {STEPS.map((step, i) => {
                const state =
                  i < run.completed ? 'done'
                  : i === 2 && run.phase === 'approval' ? 'waiting'
                  : i === 2 && run.result && run.result !== 'opened' ? 'skipped'
                  : i === run.completed && run.phase === 'working' ? 'running'
                  : 'pending';
                return (
                  <li key={step.tool} className={cn('flex items-center gap-3 text-[15px] transition-opacity duration-200', state === 'pending' && 'opacity-40')}>
                    <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
                      {state === 'done' ? <Check className="size-4 text-success" />
                      : state === 'skipped' ? <Ban className="size-3.5 text-muted-foreground" />
                      : state === 'waiting' ? <ShieldQuestion className="size-4 text-warning" />
                      : state === 'running' ? <span className="size-2 rounded-full bg-agent" />
                      : <span className="size-2 rounded-full border border-muted-foreground/60" />}
                    </span>
                    <span className={cn(state === 'skipped' && 'text-muted-foreground line-through')}>{step.label}</span>
                    <code className="ml-auto hidden font-mono text-[12px] text-muted-foreground sm:block">{step.tool}</code>
                  </li>
                );
              })}
            </ol>

            {/* Every agent surface appears in the same spot, like the app's runtime shell */}
            <div className="mt-auto flex min-h-40 items-end justify-center pt-8 sm:justify-end">
              <AnimatePresence mode="wait" initial={false}>
                {run.phase === 'listening' && inView ? (
                  <motion.div key="pill" {...enterFromBelow} animate={{ opacity: 1, y: 0, transition: SPRING }} className="sm:mx-auto">
                    <RecordingPill intent="agent" seconds={seconds} />
                  </motion.div>
                ) : run.phase === 'approval' ? (
                  <motion.div key="approval" {...enterFromBelow} animate={{ opacity: 1, y: 0, transition: SPRING }} className="agent-island w-full max-w-sm">
                    <ApprovalCard onDecide={decide} />
                  </motion.div>
                ) : run.phase === 'done' && run.result ? (
                  <motion.div key={`done-${run.result}`} {...enterFromBelow} animate={{ opacity: 1, y: 0, transition: SPRING }} className="agent-island w-full max-w-sm p-4">
                    <p className="flex items-center gap-2 text-[13px] font-semibold">
                      {run.result === 'opened' ? <Check className="size-4 text-success" aria-hidden="true" /> : <Ban className="size-4 text-muted-foreground" aria-hidden="true" />}
                      Agent finished
                    </p>
                    <p className="mt-1.5 text-[13px] leading-5 text-muted-foreground">{RESULTS[run.result]}</p>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/** Mirrors the app's approval card: header, labeled arguments, three choices. */
function ApprovalCard({ onDecide }: { onDecide: (choice: 'approved' | 'denied' | 'always-allow') => void }) {
  const button = 'h-8 cursor-pointer rounded-md px-3 text-[13px] font-medium transition-[background-color,transform] duration-150 active:scale-[0.97]';
  return (
    <>
      <div className="flex items-center gap-2.5 px-4 pt-3.5">
        <ShieldQuestion className="size-4 text-warning" aria-hidden="true" />
        <span className="text-[13px] font-semibold">Approval needed</span>
        <code className="ml-auto font-mono text-[11px] text-muted-foreground">github:create_pull</code>
      </div>
      <div className="px-4 pt-3 pb-3.5">
        <p className="text-[15px] font-semibold">Create pull</p>
        <dl className="mt-2 grid grid-cols-[5rem_1fr] gap-y-1 text-[13px] leading-5">
          <dt className="text-muted-foreground">Title</dt>
          <dd>Release notes, week 43</dd>
          <dt className="text-muted-foreground">Base</dt>
          <dd>main</dd>
        </dl>
      </div>
      <div className="flex items-center gap-1.5 border-t border-border/60 px-3 py-2.5">
        <button type="button" onClick={() => onDecide('always-allow')} className={cn(button, 'hover:bg-raised')}>
          Always allow
        </button>
        <span className="flex-1" />
        <button type="button" onClick={() => onDecide('denied')} className={cn(button, 'bg-raised hover:bg-muted')}>
          Deny
        </button>
        <button type="button" onClick={() => onDecide('approved')} className={cn(button, 'bg-voice text-on-signal hover:bg-voice/90')}>
          Approve
        </button>
      </div>
    </>
  );
}
