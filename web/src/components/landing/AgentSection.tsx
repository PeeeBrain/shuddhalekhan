import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { Reveal } from '@/components/motion/Reveal';
import { Eyebrow } from '@/components/landing/Eyebrow';

const TICK_DURATIONS = [700, 2100, 1200, 1600, 1200, 2800, 900, 3400];

const DEMO_STEPS: { label: string; tool: string; runAt: number; doneAt: number; waitAt?: number[] }[] = [
  { label: 'Read this week’s commits', tool: 'git · log', runAt: 2, doneAt: 3 },
  { label: 'Draft the release notes', tool: 'notes · write', runAt: 3, doneAt: 4 },
  { label: 'Open the pull request', tool: 'github · create_pull', runAt: 4, doneAt: 7, waitAt: [5, 6] },
];

export function AgentSection() {
  const [tick, setTick] = useState(0);

  // Cycles one scripted agent run: speak → tools → approval → result.
  useEffect(() => {
    const timeout = setTimeout(() => setTick((t) => (t + 1) % TICK_DURATIONS.length), TICK_DURATIONS[tick]);
    return () => clearTimeout(timeout);
  }, [tick]);

  return (
    <section id="agent-mode" className="relative scroll-mt-20 overflow-hidden py-28 md:py-36">
      {/* Coral signal glow — the visual signature of Agent Mode */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-10 right-[-240px] h-[560px] w-[560px] bg-[radial-gradient(closest-side,rgba(255,106,106,0.07),transparent)]"
      />

      <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-6 lg:grid-cols-12">
        <Reveal className="lg:col-span-5">
          <Eyebrow tone="agent">Agent mode</Eyebrow>
          <h2 className="mt-4 text-balance text-3xl font-semibold tracking-[-0.02em] sm:text-5xl">
            One sentence in.
            <span className="block text-muted-foreground">Finished work out.</span>
          </h2>
          <p className="mt-5 max-w-md leading-relaxed text-muted-foreground">
            Some tasks were never typing tasks. Describe the outcome, and Shuddhalekhan plans the steps, calls your
            tools, and brings back finished work. You talk. It works.
          </p>

          <div className="mt-9 space-y-6">
            <div className="border-l border-agent/60 pl-4">
              <h3 className="text-sm font-semibold text-white">Speak the outcome, skip the steps</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                A sentence becomes a plan: read, draft, create, file. The agent works through it while you talk or
                walk away.
              </p>
            </div>
            <div className="border-l border-agent/60 pl-4">
              <h3 className="text-sm font-semibold text-white">Every tool on your terms</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                Connect MCP servers, then decide tool by tool what runs unattended and what asks first. Guarded calls
                pause for a one-tap approval.
              </p>
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.1} className="lg:col-span-7">
          <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0a0b11] p-6 sm:p-8">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 font-mono text-[10px] tracking-[0.2em] text-zinc-500 uppercase">
                <span className="animate-live-dot size-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                Agent run · live demo
              </span>
              <span className="font-mono text-[10px] text-zinc-600">hands-free</span>
            </div>

            <div
              className={`mt-7 transition-all duration-700 ease-out ${tick >= 1 ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}`}
            >
              <div className="font-mono text-[10px] tracking-[0.2em] text-zinc-500 uppercase">You said</div>
              <p className="mt-2.5 text-lg leading-relaxed text-zinc-100 sm:text-xl">
                &ldquo;Draft release notes from this week&rsquo;s commits and open a PR.&rdquo;
              </p>
            </div>

            <div className="mt-7 border-t border-white/[0.06] pt-5">
              <div className="font-mono text-[10px] tracking-[0.2em] text-zinc-500 uppercase">Agent did</div>
              <ul className="mt-3.5 space-y-3">
                {DEMO_STEPS.map((step) => {
                  const status =
                    tick >= step.doneAt ? 'done'
                    : step.waitAt?.includes(tick) ? 'waiting'
                    : tick === step.runAt ? 'running'
                    : 'pending';
                  return (
                    <li
                      key={step.label}
                      className={`flex items-center gap-3 text-sm transition-opacity duration-500 ${status === 'pending' ? 'opacity-30' : 'opacity-100'}`}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        {status === 'done' ? (
                          <Check className="size-3.5 text-emerald-400" aria-hidden="true" />
                        ) : status === 'running' ? (
                          <span className="size-3 animate-spin rounded-full border border-zinc-700 border-t-agent" aria-hidden="true" />
                        ) : status === 'waiting' ? (
                          <span className="animate-live-dot size-2 rounded-full bg-agent" aria-hidden="true" />
                        ) : (
                          <span className="size-2 rounded-full border border-zinc-700" aria-hidden="true" />
                        )}
                      </span>
                      <span className={status === 'waiting' ? 'text-agent' : status === 'done' ? 'text-zinc-300' : 'text-zinc-400'}>
                        {step.label}
                      </span>
                      <span className="ml-auto font-mono text-[10px] text-zinc-600">{step.tool}</span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="mt-6 min-h-7">
              <div
                className={`flex items-center gap-2 text-sm transition-all duration-700 ease-out ${tick >= 7 ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'}`}
                style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
              >
                <Check className="size-4 text-emerald-400" aria-hidden="true" />
                <span className="text-zinc-200">Pull request opened.</span>
                <span className="ml-auto font-mono text-[10px] text-zinc-500">one approval · zero keystrokes</span>
              </div>
            </div>

            {/* Approval toast — slides in while a guarded tool waits */}
            <div
              role="presentation"
              className={`absolute right-4 bottom-4 w-64 rounded-xl border border-agent/25 bg-[#141010]/95 p-4 shadow-2xl backdrop-blur transition-all duration-500 ${
                tick === 5 || tick === 6 ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0'
              }`}
            >
              <div className="font-mono text-[9px] tracking-[0.18em] text-agent/90 uppercase">Approval needed</div>
              <div className="mt-1.5 font-mono text-xs font-semibold text-white">github · create_pull</div>
              <p className="mt-1 text-[11px] leading-snug text-zinc-400">
                Writes to your repository. You marked this tool as ask-first.
              </p>
              <div className="mt-3 flex gap-1.5">
                <span
                  className={`rounded-md px-2.5 py-1 text-[10px] font-semibold transition-all duration-300 ${
                    tick === 6 ? 'scale-95 bg-emerald-400 text-zinc-950' : 'bg-zinc-100 text-zinc-950'
                  }`}
                >
                  Allow
                </span>
                <span className="rounded-md border border-white/10 px-2.5 py-1 text-[10px] font-medium text-zinc-400">Always</span>
                <span className="rounded-md border border-white/10 px-2.5 py-1 text-[10px] font-medium text-zinc-400">Deny</span>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
