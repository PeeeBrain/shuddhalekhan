import { useState, useEffect } from 'react';
import { Check } from 'lucide-react';
import { Vscode } from '@/components/ui/svgs/vscode';
import { Slack } from '@/components/ui/svgs/slack';
import { Notion } from '@/components/ui/svgs/notion';

type ScrubPhase = 'raw' | 'strike' | 'collapse' | 'clean';

const SCRUB_PHASE_ORDER: ScrubPhase[] = ['raw', 'strike', 'collapse', 'clean'];
const SCRUB_PHASE_DURATION: Record<ScrubPhase, number> = { raw: 2400, strike: 1100, collapse: 900, clean: 3200 };

const SCRUB_SEGMENTS: { text: string; filler?: boolean }[] = [
  { text: 'um, ', filler: true },
  { text: 'so ', filler: true },
  { text: 'the installer is ' },
  { text: 'like, ', filler: true },
  { text: 'ready — ' },
  { text: 'uh, ', filler: true },
  { text: 'we can ship it tomorrow' },
];
const SCRUB_CLEAN_TEXT = 'The installer is ready — we can ship it tomorrow.';

const APP_TAB_BASE =
  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-[color,background-color,border-color,scale]';

export function HowItWorks() {
  const [activeTab, setActiveTab] = useState<'vscode' | 'slack' | 'notion'>('vscode');
  const [scrubPhase, setScrubPhase] = useState<ScrubPhase>('raw');

  // Filler-word scrub demo state machine
  useEffect(() => {
    const timeout = setTimeout(() => {
      setScrubPhase((p) => SCRUB_PHASE_ORDER[(SCRUB_PHASE_ORDER.indexOf(p) + 1) % SCRUB_PHASE_ORDER.length]);
    }, SCRUB_PHASE_DURATION[scrubPhase]);
    return () => clearTimeout(timeout);
  }, [scrubPhase]);

  const tabClass = (tab: 'vscode' | 'slack' | 'notion') =>
    `${APP_TAB_BASE} ${
      activeTab === tab
        ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/40 shadow-xs scale-105'
        : 'bg-zinc-900 text-zinc-400 hover:text-white border border-zinc-800'
    }`;

  return (
    <section id="how-it-works" className="relative z-10 scroll-mt-20 border-t border-zinc-800/60 bg-[#07080a] py-20">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-14 text-center">
          <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.22em] text-indigo-300">Zero context switching.</div>
          <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Speak once. Type anywhere.
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-zinc-400">Shuddhalekhan stays out of the way until you need it, then puts the finished text exactly where you are working.</p>
        </div>

        <div className="mb-8 grid gap-4 rounded-2xl border border-zinc-800/70 bg-zinc-950/50 px-6 py-5 sm:grid-cols-3 sm:gap-6 sm:px-8">
          {[
            { n: '01', text: 'Start dictating without leaving the window you are already in.' },
            { n: '02', text: 'Speak naturally — stumbles, ums, and false starts welcome.' },
            { n: '03', text: 'Clean, punctuated text lands exactly at your cursor.' },
          ].map(({ n, text }) => (
            <div key={n} className="flex items-baseline gap-3">
              <span className="font-mono text-[11px] font-semibold text-indigo-300">{n}</span>
              <p className="text-xs leading-relaxed text-zinc-400">{text}</p>
            </div>
          ))}
        </div>

        <div className="grid gap-6 md:grid-cols-12 items-stretch">
          <div className="md:col-span-7 flex flex-col rounded-2xl border border-zinc-800 bg-zinc-950/90 p-7 text-left">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-indigo-300">Messy in — clean out</div>
            <h3 className="mt-3 text-base font-semibold text-white">Say it how you think it.</h3>
            <p className="mt-2 max-w-md text-xs leading-relaxed text-zinc-400">
              Filler words, repeated phrases, and hesitations are stripped before the text ever touches your app.
            </p>

            <div className="mt-8 flex flex-1 flex-col justify-center rounded-xl border border-zinc-800/80 bg-[#0b0c11] p-5 sm:p-6">
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">You said</div>
              <p className="mt-2 min-h-[3.5rem] text-base leading-relaxed sm:text-lg">
                {SCRUB_SEGMENTS.map((seg, i) =>
                  seg.filler ? (
                    <span
                      key={i}
                      className={`inline-block overflow-hidden whitespace-pre align-bottom transition-[max-width,opacity,color,background-color] duration-500 ease-in-out ${
                        scrubPhase === 'raw'
                          ? 'rounded-sm bg-amber-400/10 text-amber-300 underline decoration-amber-400/60 decoration-wavy underline-offset-4'
                          : scrubPhase === 'strike'
                            ? 'text-zinc-500 line-through decoration-rose-400/70 opacity-70'
                            : 'opacity-0'
                      }`}
                      style={{ maxWidth: scrubPhase === 'collapse' || scrubPhase === 'clean' ? '0ch' : `${seg.text.length}ch` }}
                    >
                      {seg.text}
                    </span>
                  ) : (
                    <span key={i} className="whitespace-pre text-zinc-200">{seg.text}</span>
                  )
                )}
              </p>

              <div className={`mt-6 border-t border-zinc-800/80 pt-4 transition-[opacity,translate] duration-700 ${scrubPhase === 'clean' ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}`}>
                <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-400/90">
                  <Check className="size-3" /> Shuddhalekhan typed
                </div>
                <p className="mt-2 text-base leading-relaxed text-white sm:text-lg">{SCRUB_CLEAN_TEXT}</p>
              </div>
            </div>
          </div>

          {/* Authentic App Container Showcase (VS Code, Slack, Notion) */}
          <div className="md:col-span-5 rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-7 shadow-lg backdrop-blur-md flex flex-col justify-between transition-colors hover:border-zinc-700/80">
            <div>
              <h3 className="text-base font-semibold text-white mb-4">
                Types into any active app
              </h3>

              {/* App Selector Tabs with Official SVGL Brand Icons */}
              <div className="flex gap-2 mb-4">
                <button
                  type="button"
                  onClick={() => setActiveTab('vscode')}
                  className={tabClass('vscode')}
                >
                  <Vscode className="size-3.5" />
                  VS Code
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('slack')}
                  className={tabClass('slack')}
                >
                  <Slack className="size-3.5" />
                  Slack
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('notion')}
                  className={tabClass('notion')}
                >
                  <Notion className="size-3.5" />
                  Notion
                </button>
              </div>

              {/* Pixel-Matched Authentic App Shell Containers */}
              {activeTab === 'vscode' && (
                <div className="rounded-xl border border-zinc-800 bg-[#1e1e1e] overflow-hidden text-xs shadow-inner animate-fadeIn">
                  {/* VS Code Editor Tab Header */}
                  <div className="flex items-center justify-between border-b border-zinc-800 bg-[#252526] px-3 py-1.5 text-[11px] text-zinc-400 select-none">
                    <span className="flex items-center gap-1.5 bg-[#1e1e1e] text-zinc-200 px-2.5 py-0.5 rounded-t border-t-2 border-[#007ACC]">
                      <Vscode className="size-3" />
                      keyboard.ts
                    </span>
                    <span className="text-[10px] text-zinc-500 font-mono">VS Code</span>
                  </div>
                  {/* Real source from app/src/main/native/keyboard.ts (lines 97-103) with a dictated comment above it */}
                  <div className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-[#d4d4d4]">
                    <div className="flex gap-3">
                      <span className="w-5 shrink-0 select-none text-right text-[#858585]">96</span>
                      <span className="whitespace-pre text-[#6a9955]">    // low-level hook hears every keystroke on the desktop<span className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-emerald-400 align-middle" /></span>
                    </div>
                    <div className="flex gap-3">
                      <span className="w-5 shrink-0 select-none text-right text-[#858585]">97</span>
                      <span className="whitespace-pre">    <span className="text-[#569cd6]">this</span>.<span className="text-[#9cdcfe]">callback</span> = <span className="text-[#9cdcfe]">koffi</span>.<span className="text-[#dcdcaa]">register</span>(<span className="text-[#9cdcfe]">proc</span>, <span className="text-[#9cdcfe]">koffi</span>.<span className="text-[#dcdcaa]">pointer</span>(<span className="text-[#9cdcfe]">callbackProto</span>));</span>
                    </div>
                    <div className="flex gap-3">
                      <span className="w-5 shrink-0 select-none text-right text-[#858585]">98</span>
                      <span className="whitespace-pre">    <span className="text-[#569cd6]">const</span> <span className="text-[#9cdcfe]">hModule</span> = <span className="text-[#dcdcaa]">GetModuleHandle</span>(<span className="text-[#569cd6]">undefined</span>);</span>
                    </div>
                    <div className="flex gap-3">
                      <span className="w-5 shrink-0 select-none text-right text-[#858585]">99</span>
                      <span className="whitespace-pre">    <span className="text-[#569cd6]">this</span>.<span className="text-[#9cdcfe]">hookHandle</span> = <span className="text-[#dcdcaa]">SetWindowsHookEx</span>(<span className="text-[#4fc1ff]">WH_KEYBOARD_LL</span>, <span className="text-[#569cd6]">this</span>.<span className="text-[#9cdcfe]">callback</span>, <span className="text-[#9cdcfe]">hModule</span>, <span className="text-[#b5cea8]">0</span>);</span>
                    </div>
                    <div className="flex gap-3">
                      <span className="w-5 shrink-0 select-none text-right text-[#858585]">100</span>
                      <span className="whitespace-pre"> </span>
                    </div>
                    <div className="flex gap-3">
                      <span className="w-5 shrink-0 select-none text-right text-[#858585]">101</span>
                      <span className="whitespace-pre">    <span className="text-[#c586c0]">if</span> (!<span className="text-[#569cd6]">this</span>.<span className="text-[#9cdcfe]">hookHandle</span>) {'{'}</span>
                    </div>
                    <div className="flex gap-3">
                      <span className="w-5 shrink-0 select-none text-right text-[#858585]">102</span>
                      <span className="whitespace-pre">      <span className="text-[#c586c0]">throw new</span> <span className="text-[#4ec9b0]">Error</span>(<span className="text-[#ce9178]">'Failed to install keyboard hook'</span>);</span>
                    </div>
                    <div className="flex gap-3">
                      <span className="w-5 shrink-0 select-none text-right text-[#858585]">103</span>
                      <span className="whitespace-pre">    {'}'}</span>
                    </div>
                  </div>
                  {/* VS Code Status Bar with the real file path */}
                  <div className="flex items-center justify-between bg-[#007acc] px-3 py-1 font-mono text-[10px] text-white/90 select-none">
                    <span>app/src/main/native/keyboard.ts</span>
                    <span>TypeScript · Ln 96, Col 58</span>
                  </div>
                </div>
              )}

              {activeTab === 'slack' && (
                <div className="rounded-xl border border-zinc-800 bg-[#1a1d21] overflow-hidden text-xs shadow-inner animate-fadeIn">
                  {/* Slack Channel Header */}
                  <div className="border-b border-zinc-800 bg-[#1a1d21] px-3 py-2 text-[11px] font-semibold text-zinc-300 select-none flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="text-zinc-500 font-bold">#</span> general
                      <span className="text-[10px] text-zinc-500 font-normal border-l border-zinc-800 pl-2">42 members</span>
                    </div>
                    <Slack className="size-3.5" />
                  </div>
                  {/* Slack Message Box */}
                  <div className="p-3 flex gap-2.5">
                    <div className="size-6 rounded-md bg-emerald-600 flex items-center justify-center text-[10px] font-bold text-white shrink-0 shadow-xs">
                      PS
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-zinc-200 text-[11px]">PeeeBrain</span>
                        <span className="text-[10px] text-zinc-500">10:42 AM</span>
                      </div>
                      <p className="mt-0.5 text-zinc-300 text-[11px] leading-snug">
                        Pushed the latest update to main! All tests passing cleanly.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'notion' && (
                <div className="rounded-xl border border-zinc-800 bg-[#191919] overflow-hidden text-xs shadow-inner p-3.5 animate-fadeIn">
                  {/* Notion Breadcrumbs & Header */}
                  <div className="flex items-center justify-between mb-1 select-none">
                    <div className="text-[10px] text-zinc-500">Workspace / 📝 Notes</div>
                    <Notion className="size-3" />
                  </div>
                  <div className="font-semibold text-zinc-200 text-xs mb-2">⚡ Project Roadmap</div>
                  <div className="flex items-start gap-1.5 text-[11px] text-zinc-300 font-sans">
                    <span className="text-zinc-600 select-none cursor-grab">⋮⋮</span>
                    <p className="leading-relaxed">
                      Meeting Notes: Deliver a clean, unpretentious voice typing experience on Windows without paywalls.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
