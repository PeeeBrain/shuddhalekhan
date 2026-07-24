import { useState, useEffect } from 'react';
import { Check } from 'lucide-react';

const AGENT_TICK_DURATIONS = [700, 2100, 1200, 1600, 1200, 2800, 900, 3400];

const AGENT_DEMO_STEPS: { label: string; tool: string; runAt: number; doneAt: number; waitAt?: number[] }[] = [
  { label: 'Read this week’s commits', tool: 'git · log', runAt: 2, doneAt: 3 },
  { label: 'Draft the release notes', tool: 'notes · write', runAt: 3, doneAt: 4 },
  { label: 'Open the pull request', tool: 'github · create_pull', runAt: 4, doneAt: 7, waitAt: [5, 6] },
];

export function AgentSection() {
  const [agentTick, setAgentTick] = useState(0);

  // Agent run demo ticker
  useEffect(() => {
    const timeout = setTimeout(() => {
      setAgentTick((t) => (t + 1) % AGENT_TICK_DURATIONS.length);
    }, AGENT_TICK_DURATIONS[agentTick]);
    return () => clearTimeout(timeout);
  }, [agentTick]);

  return (
    <section id="capabilities" className="relative z-10 scroll-mt-20 border-t border-zinc-800/60 py-20">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid items-center gap-10 md:grid-cols-12">
          <div className="md:col-span-5">
            <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-indigo-300">Beyond dictation</div>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Don&rsquo;t just dictate. Delegate.
            </h2>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-zinc-400">
              Some tasks were never typing tasks. Say the outcome and Shuddhalekhan plans the steps, calls your tools, and hands back finished work — while your hands stay off the keyboard.
            </p>

            <div className="mt-8 space-y-6">
              <div className="border-l-2 border-indigo-500/60 pl-4">
                <h3 className="text-sm font-semibold text-white">Speak the outcome, skip the steps</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
                  A sentence becomes a sequence — read, draft, create, file. Agents work through it while you keep talking, or walk away.
                </p>
              </div>
              <div className="border-l-2 border-emerald-500/60 pl-4">
                <h3 className="text-sm font-semibold text-white">Every tool on your terms</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
                  Connect MCP servers and decide tool by tool what runs unattended and what must ask first. Guarded calls pause for a one-tap approval — control without babysitting.
                </p>
              </div>
            </div>
          </div>

          <div className="md:col-span-7">
            <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/90 p-6 sm:p-7">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                  <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
                  Agent run — live demo
                </span>
                <span className="font-mono text-[10px] text-zinc-600">hands-free</span>
              </div>

              <div className={`mt-6 transition-[opacity,translate] duration-700 ${agentTick >= 1 ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}`}>
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">You said</div>
                <p className="mt-2 text-base leading-relaxed text-zinc-100 sm:text-lg">
                  &ldquo;Draft release notes from this week&rsquo;s commits and open a PR.&rdquo;
                </p>
              </div>

              <div className="mt-6 border-t border-zinc-800/80 pt-4">
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">Agent did</div>
                <ul className="mt-3 space-y-2.5">
                  {AGENT_DEMO_STEPS.map((step) => {
                    const status =
                      agentTick >= step.doneAt
                        ? 'done'
                        : step.waitAt?.includes(agentTick)
                          ? 'waiting'
                          : agentTick === step.runAt
                            ? 'running'
                            : 'pending';
                    return (
                      <li key={step.label} className={`flex items-center gap-3 text-sm transition-opacity duration-500 ${status === 'pending' ? 'opacity-30' : 'opacity-100'}`}>
                        <span className="flex size-4 shrink-0 items-center justify-center">
                          {status === 'done' ? (
                            <Check className="size-3.5 text-emerald-400" />
                          ) : status === 'running' ? (
                            <span className="size-3 animate-spin rounded-full border border-zinc-700 border-t-indigo-300" />
                          ) : status === 'waiting' ? (
                            <span className="size-2 animate-pulse rounded-full bg-amber-400" />
                          ) : (
                            <span className="size-2 rounded-full border border-zinc-700" />
                          )}
                        </span>
                        <span className={status === 'waiting' ? 'text-amber-200' : status === 'done' ? 'text-zinc-300' : 'text-zinc-400'}>
                          {step.label}
                        </span>
                        <span className="ml-auto font-mono text-[10px] text-zinc-600">{step.tool}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>

              <div className="mt-5 min-h-[1.75rem]">
                <div className={`flex items-center gap-2 text-sm transition-[opacity,translate] duration-700 ${agentTick >= 7 ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'}`}>
                  <Check className="size-4 text-emerald-400" />
                  <span className="text-zinc-200">Pull request opened.</span>
                  <span className="ml-auto font-mono text-[10px] text-zinc-500">one approval · zero keystrokes</span>
                </div>
              </div>

              {/* Approval toast — slides in when a guarded tool wants to run */}
              <div className={`absolute bottom-4 right-4 w-64 rounded-xl border border-amber-400/30 bg-[#141210]/95 p-4 shadow-2xl backdrop-blur transition-[opacity,translate] duration-500 ${agentTick === 5 || agentTick === 6 ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0'}`}>
                <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-amber-300/90">Approval needed</div>
                <div className="mt-1.5 font-mono text-xs font-semibold text-white">github · create_pull</div>
                <p className="mt-1 text-[11px] leading-snug text-zinc-400">Writes to your repository. You marked this tool as ask-first.</p>
                <div className="mt-3 flex gap-1.5">
                  <span className={`rounded-md px-2.5 py-1 text-[10px] font-semibold transition-[scale,background-color,color] ${agentTick === 6 ? 'scale-95 bg-emerald-400 text-zinc-950' : 'bg-zinc-100 text-zinc-950'}`}>Allow</span>
                  <span className="rounded-md border border-zinc-700 px-2.5 py-1 text-[10px] font-medium text-zinc-400">Always</span>
                  <span className="rounded-md border border-zinc-700 px-2.5 py-1 text-[10px] font-medium text-zinc-400">Deny</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
