import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { Reveal } from '@/components/motion/Reveal';
import { Eyebrow } from '@/components/landing/Eyebrow';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Vscode } from '@/components/ui/svgs/vscode';
import { Slack } from '@/components/ui/svgs/slack';
import { Notion } from '@/components/ui/svgs/notion';
import { cn } from '@/lib/utils';

type ScrubPhase = 'raw' | 'strike' | 'collapse' | 'clean';

const SCRUB_PHASE_ORDER: ScrubPhase[] = ['raw', 'strike', 'collapse', 'clean'];
const SCRUB_PHASE_DURATION: Record<ScrubPhase, number> = { raw: 2400, strike: 1100, collapse: 900, clean: 3200 };

const SCRUB_SEGMENTS: { text: string; filler?: boolean }[] = [
  { text: 'um, ', filler: true },
  { text: 'so ', filler: true },
  { text: 'the installer is ' },
  { text: 'like, ', filler: true },
  { text: 'ready, ' },
  { text: 'uh, ', filler: true },
  { text: 'we can ship it tomorrow' },
];
const SCRUB_CLEAN_TEXT = 'The installer is ready. We can ship it tomorrow.';

const STEPS = [
  { n: '01', title: 'Press the shortcut', text: 'Start talking without leaving your current window.' },
  { n: '02', title: 'Speak naturally', text: 'Stumbles, ums, and false starts are all welcome.' },
  { n: '03', title: 'Get clean text', text: 'Punctuated writing lands at your cursor.' },
];

/* Shared by every app tab: pointer cursor (Tailwind preflight defaults buttons
   to cursor-default), quiet fill on hover, brighter pill when active. */
const TRIGGER_CLASS =
  'cursor-pointer rounded-full px-3 py-1 text-xs font-medium text-zinc-400 transition-colors duration-300 '
  + 'data-[state=inactive]:hover:bg-white/[0.06] data-[state=inactive]:hover:text-white '
  + 'data-[state=active]:bg-white/[0.09] data-[state=active]:text-white';

/** Cycles raw → strike fillers → collapse → clean, forever. */
function useScrubPhase() {
  const [phase, setPhase] = useState<ScrubPhase>('raw');

  useEffect(() => {
    const timeout = setTimeout(() => {
      setPhase((p) => SCRUB_PHASE_ORDER[(SCRUB_PHASE_ORDER.indexOf(p) + 1) % SCRUB_PHASE_ORDER.length]);
    }, SCRUB_PHASE_DURATION[phase]);
    return () => clearTimeout(timeout);
  }, [phase]);

  return phase;
}

export function DictationSection() {
  const scrubPhase = useScrubPhase();

  return (
    <section id="how-it-works" className="relative scroll-mt-20 py-28 md:py-36">
      {/* Faint signal glow anchoring the section */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/4 left-[-200px] h-[480px] w-[480px] bg-[radial-gradient(closest-side,rgba(133,146,255,0.06),transparent)]"
      />

      <div className="relative mx-auto max-w-6xl px-6">
        <Reveal className="mx-auto max-w-2xl text-center">
          <Eyebrow>Dictation</Eyebrow>
          <h2 className="mt-4 text-balance text-3xl font-semibold tracking-[-0.02em] sm:text-5xl">
            From messy speech to finished writing.
          </h2>
          <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">
            It sits quietly until you press the shortcut. Then finished text lands right where you’re working.
          </p>
        </Reveal>

        <Reveal delay={0.08} className="mt-14 grid gap-x-10 gap-y-6 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-7 py-6 sm:grid-cols-3 sm:px-9">
          {STEPS.map(({ n, title, text }) => (
            <div key={n} className="flex flex-col gap-1.5">
              <span className="font-mono text-xs font-semibold text-voice">{n}</span>
              <p className="text-sm font-semibold text-zinc-100">{title}</p>
              <p className="text-[13px] leading-relaxed text-muted-foreground">{text}</p>
            </div>
          ))}
        </Reveal>

        {/* Messy in — clean out */}
        <Reveal delay={0.12} className="mt-6">
          <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0a0b11]">
            <div className="grid md:grid-cols-[1fr_240px]">
              <div className="border-b border-white/[0.06] p-7 sm:p-10 md:border-r md:border-b-0">
                <div className="font-mono text-[10px] tracking-[0.2em] text-zinc-500 uppercase">You said</div>
                <p className="mt-4 min-h-16 text-lg leading-relaxed sm:text-xl">
                  {SCRUB_SEGMENTS.map((seg, i) =>
                    seg.filler ? (
                      <span
                        key={i}
                        className={cn(
                          'inline-block overflow-hidden whitespace-pre align-bottom transition-all duration-500 ease-in-out',
                          scrubPhase === 'raw' &&
                            'rounded-sm bg-amber-400/10 text-amber-300 underline decoration-wavy decoration-amber-400/60 underline-offset-4',
                          scrubPhase === 'strike' && 'text-zinc-500 line-through decoration-agent/70 opacity-70',
                          (scrubPhase === 'collapse' || scrubPhase === 'clean') && 'opacity-0',
                        )}
                        style={{ maxWidth: scrubPhase === 'collapse' || scrubPhase === 'clean' ? '0ch' : `${seg.text.length}ch` }}
                      >
                        {seg.text}
                      </span>
                    ) : (
                      <span key={i} className="whitespace-pre text-zinc-200">{seg.text}</span>
                    ),
                  )}
                </p>

                <div
                  className={cn(
                    'mt-8 border-t border-white/[0.06] pt-5 transition-all duration-700 ease-out',
                    scrubPhase === 'clean' ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
                  )}
                >
                  <div className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.2em] text-emerald-400/90 uppercase">
                    <Check className="size-3" aria-hidden="true" /> Shuddhalekhan typed
                  </div>
                  <p className="mt-2.5 text-lg leading-relaxed text-white sm:text-xl">{SCRUB_CLEAN_TEXT}</p>
                </div>
              </div>

              <div className="flex flex-col justify-center gap-4 bg-white/[0.015] p-7">
                {[
                  ['Fillers removed', 'um · like · uh'],
                  ['Punctuation added', 'commas and periods'],
                  ['Typed at your cursor', 'no app switching'],
                ].map(([title, detail]) => (
                  <div key={title}>
                    <p className="text-[13px] font-semibold text-zinc-200">{title}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">{detail}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Reveal>

        {/* Types into any app */}
        <Reveal delay={0.16} className="mt-6">
          <Tabs defaultValue="vscode" className="w-full">
            <div className="mb-5 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
              <h3 className="text-base font-semibold text-zinc-100">Types straight into whatever is focused.</h3>
              <TabsList className="h-9 gap-1 rounded-full border border-white/[0.08] bg-white/[0.03] p-1">
                <TabsTrigger value="vscode" className={TRIGGER_CLASS}>
                  <Vscode className="size-3.5" /> VS Code
                </TabsTrigger>
                <TabsTrigger value="slack" className={TRIGGER_CLASS}>
                  <Slack className="size-3.5" /> Slack
                </TabsTrigger>
                <TabsTrigger value="notion" className={TRIGGER_CLASS}>
                  <Notion className="size-3.5" /> Notion
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="vscode" className="animate-content-in">
              <div className="overflow-hidden rounded-xl border border-white/[0.08] text-xs">
                <div className="flex items-center justify-between border-b border-white/[0.06] bg-[#252526] px-3 py-1.5 text-[11px] text-zinc-400 select-none">
                  <span className="flex items-center gap-1.5 rounded-t border-t-2 border-[#007ACC] bg-[#1e1e1e] px-2.5 py-0.5 text-zinc-200">
                    <Vscode className="size-3" />
                    keyboard.ts
                  </span>
                  <span className="font-mono text-[10px] text-zinc-500">VS Code</span>
                </div>
                <div className="overflow-x-auto bg-[#1e1e1e] p-3 font-mono text-[11px] leading-relaxed text-[#d4d4d4]">
                  <div className="flex gap-3">
                    <span className="w-5 shrink-0 text-right text-[#858585] select-none">96</span>
                    <span className="whitespace-pre text-[#6a9955]">{'// low-level hook hears every keystroke on the desktop'}<span className="animate-caret ml-0.5 inline-block h-3 w-[2px] bg-emerald-400 align-middle" /></span>
                  </div>
                  <div className="flex gap-3">
                    <span className="w-5 shrink-0 text-right text-[#858585] select-none">97</span>
                    <span className="whitespace-pre"><span className="text-[#569cd6]">this</span>.<span className="text-[#9cdcfe]">callback</span> = <span className="text-[#9cdcfe]">koffi</span>.<span className="text-[#dcdcaa]">register</span>(<span className="text-[#9cdcfe]">proc</span>, <span className="text-[#9cdcfe]">koffi</span>.<span className="text-[#dcdcaa]">pointer</span>(<span className="text-[#9cdcfe]">callbackProto</span>));</span>
                  </div>
                  <div className="flex gap-3">
                    <span className="w-5 shrink-0 text-right text-[#858585] select-none">98</span>
                    <span className="whitespace-pre"><span className="text-[#569cd6]">const</span> <span className="text-[#9cdcfe]">hModule</span> = <span className="text-[#dcdcaa]">GetModuleHandle</span>(<span className="text-[#569cd6]">undefined</span>);</span>
                  </div>
                  <div className="flex gap-3">
                    <span className="w-5 shrink-0 text-right text-[#858585] select-none">99</span>
                    <span className="whitespace-pre"><span className="text-[#569cd6]">this</span>.<span className="text-[#9cdcfe]">hookHandle</span> = <span className="text-[#dcdcaa]">SetWindowsHookEx</span>(<span className="text-[#4fc1ff]">WH_KEYBOARD_LL</span>, <span className="text-[#569cd6]">this</span>.<span className="text-[#9cdcfe]">callback</span>, <span className="text-[#9cdcfe]">hModule</span>, <span className="text-[#b5cea8]">0</span>);</span>
                  </div>
                </div>
                <div className="flex items-center justify-between bg-[#007acc] px-3 py-1 font-mono text-[10px] text-white/90 select-none">
                  <span>app/src/main/native/keyboard.ts</span>
                  <span>TypeScript · Ln 96, Col 58</span>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="slack" className="animate-content-in">
              <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#1a1d21] text-xs">
                <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2 text-[11px] font-semibold text-zinc-300 select-none">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-zinc-500">#</span> general
                    <span className="border-l border-white/[0.08] pl-2 text-[10px] font-normal text-zinc-500">42 members</span>
                  </div>
                  <Slack className="size-3.5" />
                </div>
                <div className="flex gap-2.5 p-3">
                  <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-emerald-600 text-[10px] font-bold text-white">PS</div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold text-zinc-200">PeeeBrain</span>
                      <span className="text-[10px] text-zinc-500">10:42 AM</span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-snug text-zinc-300">
                      Pushed the latest update to main! All tests green.
                    </p>
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="notion" className="animate-content-in">
              <div className="rounded-xl border border-white/[0.08] bg-[#191919] p-3.5 text-xs">
                <div className="mb-1 flex items-center justify-between select-none">
                  <div className="text-[10px] text-zinc-500">Workspace / Notes</div>
                  <Notion className="size-3" />
                </div>
                <div className="mb-2 text-xs font-semibold text-zinc-200">Project Roadmap</div>
                <div className="flex items-start gap-1.5 font-sans text-[11px] text-zinc-300">
                  <span className="cursor-grab text-zinc-600 select-none">⋮⋮</span>
                  <p className="leading-relaxed">Meeting notes: voice typing on Windows should be free and run locally. Ship it.</p>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </Reveal>
      </div>
    </section>
  );
}
