import { useState, useEffect } from 'react';
import { Vscode } from '@/components/ui/svgs/vscode';
import { Slack } from '@/components/ui/svgs/slack';
import { Notion } from '@/components/ui/svgs/notion';

const TYPEWRITER_PHRASES = [
  'Hey Sarah, just pushed the fix for the authentication bug to staging. Can you take a look when you get a chance?',
  '// Todo: Optimize local database query and add automatic retry logic for failed network requests.',
  'Hi Alex, thanks for the quick call today. I have updated the project proposal with the timeline we agreed on.',
  'Key takeaways from today: prioritize user feedback, ship the Windows installer update, and review release notes.',
];

export function LandingPage() {
  const [activeTab, setActiveTab] = useState<'vscode' | 'slack' | 'notion'>('vscode');
  const [seconds, setSeconds] = useState(2);
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [animHeights, setAnimHeights] = useState<number[]>([40, 70, 35, 90, 60, 100, 45, 85, 50, 95, 30, 75, 40, 65]);

  // Audio Equalizer live soundwave modulation (gentle, smooth transition)
  useEffect(() => {
    const eqTimer = setInterval(() => {
      setAnimHeights(prev =>
        prev.map((h) => Math.max(15, Math.min(100, h + (Math.random() * 20 - 10))))
      );
    }, 400);
    return () => clearInterval(eqTimer);
  }, []);

  // Timer counter
  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds((s) => (s + 1) % 60);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Live Typewriter Effect in Hero Windows Editor Frame
  useEffect(() => {
    const currentPhrase = TYPEWRITER_PHRASES[phraseIdx];

    const typeSpeed = isDeleting ? 30 : 60;
    const timeout = setTimeout(() => {
      if (!isDeleting && charIdx < currentPhrase.length) {
        setCharIdx((c) => c + 1);
      } else if (!isDeleting && charIdx === currentPhrase.length) {
        setTimeout(() => setIsDeleting(true), 2500);
      } else if (isDeleting && charIdx > 0) {
        setCharIdx((c) => c - 1);
      } else if (isDeleting && charIdx === 0) {
        setIsDeleting(false);
        setPhraseIdx((p) => (p + 1) % TYPEWRITER_PHRASES.length);
      }
    }, typeSpeed);

    return () => clearTimeout(timeout);
  }, [charIdx, isDeleting, phraseIdx]);

  const formatTimer = (s: number) => {
    const mins = Math.floor(s / 60).toString().padStart(2, '0');
    const secs = (s % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
  };

  return (
    <div className="min-h-screen bg-[#07080a] text-zinc-100 font-sans selection:bg-zinc-700 selection:text-white">
      {/* Ambient background glow - static subtle glow without strobing pulse */}
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[1200px] h-[450px] bg-gradient-to-b from-indigo-500/10 via-purple-500/5 to-transparent blur-3xl pointer-events-none" />

      {/* Navigation Bar */}
      <header className="sticky top-0 z-30 border-b border-zinc-800/60 bg-[#07080a]/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <a href="#" className="flex items-center gap-3 group">
            {/* Pill Vector Logo */}
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#141526] border border-white/10 shadow-md shadow-indigo-500/25 transition-transform group-hover:scale-105">
              <div className="flex items-center gap-1">
                <svg className="size-3.5 text-[#8592ff]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                </svg>
                <div className="flex items-center gap-[1.5px] h-3">
                  <div className="w-[2px] h-2.5 rounded-full bg-white/90 shadow-[0_0_4px_rgba(133,146,255,0.6)]" />
                  <div className="w-[2px] h-3.5 rounded-full bg-white/90 shadow-[0_0_4px_rgba(133,146,255,0.6)]" />
                  <div className="w-[2px] h-2 rounded-full bg-white/90 shadow-[0_0_4px_rgba(133,146,255,0.6)]" />
                </div>
              </div>
            </div>

            <span className="text-base font-semibold tracking-tight text-white">Shuddhalekhan</span>
          </a>

          <nav className="hidden items-center gap-8 text-xs font-medium text-zinc-400 md:flex">
            <a href="#narrative" className="transition hover:text-white">Rationale</a>
            <a href="#destinations" className="transition hover:text-white">Destinations</a>
            <a href="#capabilities" className="transition hover:text-white">Capabilities</a>
          </nav>

          <div className="flex items-center">
            <a
              href="https://github.com/PeeeBrain/shuddhalekhan"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-xs font-medium text-zinc-400 transition hover:text-white"
            >
              <svg className="size-4 fill-current" viewBox="0 0 1024 1024" aria-hidden="true">
                <path fillRule="evenodd" d="M512 0C229.12 0 0 229.12 0 512c0 226.56 146.56 417.92 350.08 485.76 25.6 4.48 35.2-10.88 35.2-24.32 0-12.16-.64-52.48-.64-95.36-128.64 23.68-161.92-31.36-172.16-60.16-5.76-14.72-30.72-60.16-52.48-72.32-17.92-9.6-43.52-33.28-.64-33.92 40.32-.64 69.12 37.12 78.72 52.48 46.08 77.44 119.68 55.68 149.12 42.24 4.48-33.28 17.92-55.68 32.64-68.48-113.92-12.8-232.96-56.96-232.96-252.8 0-55.68 19.84-101.76 52.48-137.6-5.12-12.8-23.04-65.28 5.12-135.68 0 0 42.88-13.44 140.8 52.48 40.96-11.52 84.48-17.28 128-17.28s87.04 5.76 128 17.28c97.92-66.56 140.8-52.48 140.8-52.48 28.16 70.4 10.24 122.88 5.12 135.68 32.64 35.84 52.48 81.28 52.48 137.6 0 196.48-119.68 240-233.6 252.8 18.56 16 34.56 46.72 34.56 94.72 0 68.48-.64 123.52-.64 140.8 0 13.44 9.6 29.44 35.2 24.32C877.44 929.92 1024 737.92 1024 512 1024 229.12 794.88 0 512 0" clipRule="evenodd" />
              </svg>
              GitHub
            </a>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative z-10 mx-auto max-w-5xl px-6 pt-20 pb-16 text-center md:pt-24">
        <h1 className="mx-auto max-w-4xl text-balance text-4xl font-semibold tracking-tight text-white sm:text-6xl md:text-7xl leading-[1.08]">
          Voice dictation for Windows.<br />
          <span className="bg-gradient-to-r from-zinc-200 via-zinc-400 to-zinc-500 bg-clip-text text-transparent">
            No paywalls. No subscriptions.
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-balance text-base leading-relaxed text-zinc-400">
          Shuddhalekhan brings instant voice dictation directly into any application. Built as a free open-source alternative to paywalled dictation tools.
        </p>

        {/* Editorial Etymology Card */}
        <div className="mx-auto mt-7 max-w-lg rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4 text-left shadow-sm backdrop-blur-md transition-all hover:border-zinc-700/80">
          <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2 mb-2.5">
            <div className="flex items-baseline gap-2.5">
              <span className="font-serif text-sm font-semibold tracking-wide text-white">shud·dha·le·khan</span>
              <span className="font-mono text-[11px] text-indigo-400">/ʃud̪ˑʱəleˑkʰən/</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded bg-indigo-500/10 px-2 py-0.5 text-[11px] font-medium text-indigo-300 border border-indigo-500/20">
                शुद्धलेखन
              </span>
              <span className="text-[10px] text-zinc-500 font-mono">noun</span>
            </div>
          </div>
          <p className="text-xs leading-relaxed text-zinc-300 font-sans">
            <span className="text-zinc-400 italic">Marathi origin:</span> <strong className="text-white font-medium">&quot;Correct writing&quot;</strong> — The traditional practice of writing words accurately according to grammar, spelling, and phonetic purity.
          </p>
        </div>

        {/* Single Primary Action Row with Official Windows Logo SVG */}
        <div className="mt-9 flex justify-center">
          <a
            href="https://github.com/PeeeBrain/shuddhalekhan/releases/latest"
            target="_blank"
            rel="noreferrer"
            className="flex h-12 items-center gap-2.5 rounded-full bg-zinc-100 px-7 text-xs font-semibold text-zinc-950 shadow-xl transition hover:bg-white active:scale-95 hover:shadow-indigo-500/20"
          >
            <svg className="size-3.5 fill-current text-zinc-950" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M0 0h7.5v7.5H0V0zm8.5 0H16v7.5H8.5V0zM0 8.5h7.5V16H0V8.5zm8.5 0H16V16H8.5V8.5z" />
            </svg>
            Download for Windows (.exe)
          </a>
        </div>

        {/* Authentic Windows 11 Desktop Showcase Frame with Gentle Floating Micro-Animation */}
        <div className="mt-14 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl transition-transform duration-500 hover:-translate-y-1 hover:shadow-indigo-500/10">
          {/* Authentic Windows 11 Titlebar */}
          <div className="flex items-center justify-between border-b border-zinc-800/80 bg-[#181920] px-4 py-2.5 text-xs text-zinc-400 select-none">
            {/* Left Title with Document Icon */}
            <div className="flex items-center gap-2">
              <svg className="size-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span className="font-sans text-xs text-zinc-300 font-medium">
                Untitled Document — Shuddhalekhan Active
              </span>
            </div>

            {/* Authentic Windows 11 Window Control Buttons */}
            <div className="flex items-center gap-4 text-zinc-400">
              <span className="text-zinc-500 font-mono text-[10px]">Windows x64</span>
              <div className="flex items-center gap-3 border-l border-zinc-800 pl-3">
                {/* Minimize — */}
                <button type="button" aria-label="Minimize" className="text-zinc-400 hover:text-white transition">
                  <svg className="size-3" viewBox="0 0 12 12" fill="currentColor">
                    <rect y="5" width="12" height="1.5" />
                  </svg>
                </button>
                {/* Maximize ☐ */}
                <button type="button" aria-label="Maximize" className="text-zinc-400 hover:text-white transition">
                  <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
                    <rect x="1.5" y="1.5" width="9" height="9" />
                  </svg>
                </button>
                {/* Close ✕ */}
                <button type="button" aria-label="Close" className="text-zinc-400 hover:text-rose-400 transition">
                  <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
                    <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          {/* Windows Editor Workspace Area with Live Animated Typewriter Stream */}
          <div className="relative min-h-[340px] bg-[#0c0d12] p-6 text-left font-mono text-xs leading-relaxed text-zinc-300 sm:p-10">
            <div className="max-w-2xl space-y-3">
              <div className="text-zinc-500">// Dictating into active cursor focus target...</div>

              {/* Live Streaming Typewriter Text */}
              <div className="min-h-[48px] font-sans text-base leading-relaxed text-zinc-100">
                <span>{TYPEWRITER_PHRASES[phraseIdx].slice(0, charIdx)}</span>
                <span className="ml-0.5 inline-block w-0.5 h-4 bg-indigo-400 align-middle" />
              </div>

              <p className="text-xs font-sans leading-relaxed text-zinc-500 border-l-2 border-indigo-500/80 pl-3 italic">
                (Hesitations and filler words removed automatically before text injection...)
              </p>
            </div>

            {/* Floating Recording Pill Widget with Live Audio Equalizer Motion */}
            <div className="mt-12 flex justify-center">
              <div className="flex items-center gap-4 rounded-full border border-white/15 bg-[#141526]/95 px-6 py-3 shadow-2xl backdrop-blur-2xl transition-all hover:border-indigo-400/40 hover:shadow-indigo-500/20">
                <svg className="size-4.5 text-[#8592ff]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" x2="12" y1="19" y2="22" />
                </svg>

                {/* Animated Equalizer Soundwave Bars (Subtle & Fluid) */}
                <div className="flex items-center gap-1 h-5" aria-hidden="true">
                  {animHeights.map((h, idx) => (
                    <div
                      key={idx}
                      className="w-[3px] rounded-full bg-white transition-all duration-300 ease-in-out shadow-[0_0_6px_rgba(133,146,255,0.6)]"
                      style={{
                        height: `${Math.max(4, h * 0.2)}px`,
                      }}
                    />
                  ))}
                </div>

                {/* Timer */}
                <span className="font-mono text-xs text-white/90 font-semibold tracking-wider">
                  {formatTimer(seconds)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Creator Testimony & Authentic App Containers Bento Grid */}
      <section id="narrative" className="relative z-10 border-t border-zinc-800/60 bg-[#07080a] py-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mb-14 text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Why Shuddhalekhan Was Created
            </h2>
          </div>

          <div className="grid gap-6 md:grid-cols-12 items-stretch">
            {/* Authentic Creator Testimony Card */}
            <div className="md:col-span-7 rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-7 shadow-lg backdrop-blur-md flex flex-col justify-between transition-all hover:border-zinc-700/80">
              <div>
                <div className="flex items-center gap-2.5 mb-4">
                  <div className="size-7 rounded-full bg-indigo-600/30 border border-indigo-500/40 flex items-center justify-center text-xs font-semibold text-indigo-300">
                    PS
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-white">A note from the creator</div>
                    <div className="text-[10px] text-zinc-500">Partha Shirolkar</div>
                  </div>
                </div>

                <h3 className="text-base font-medium leading-relaxed text-zinc-200 italic">
                  &quot;I loved what Wispr Flow represented; having a &quot;touch free&quot; typing experience. But I couldn&apos;t help but wonder if something similar can be developed with an offline first framework in mind and open-source it.&quot;
                </h3>

                <p className="mt-4 text-xs leading-relaxed text-zinc-400">
                  As the app evolved, I saw an opportunity to expand this as a voice-assistant tool; powered by Agentic AI capabilities, while also letting users customize which LLM providers to use and what tools/MCPs they wanted to leverage. But my core rationale was always to give an open-source alternative that users can have more control upon.
                </p>
              </div>
            </div>

            {/* Authentic App Container Showcase (VS Code, Slack, Notion) */}
            <div id="destinations" className="md:col-span-5 rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-7 shadow-lg backdrop-blur-md flex flex-col justify-between transition-all hover:border-zinc-700/80">
              <div>
                <h3 className="text-base font-semibold text-white mb-4">
                  Types into any active app
                </h3>

                {/* App Selector Tabs with Official SVGL Brand Icons */}
                <div className="flex gap-2 mb-4">
                  <button
                    type="button"
                    onClick={() => setActiveTab('vscode')}
                    className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                      activeTab === 'vscode'
                        ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/40 shadow-xs scale-105'
                        : 'bg-zinc-900 text-zinc-400 hover:text-white border border-zinc-800'
                    }`}
                  >
                    <Vscode className="size-3.5" />
                    VS Code
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('slack')}
                    className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                      activeTab === 'slack'
                        ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/40 shadow-xs scale-105'
                        : 'bg-zinc-900 text-zinc-400 hover:text-white border border-zinc-800'
                    }`}
                  >
                    <Slack className="size-3.5" />
                    Slack
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('notion')}
                    className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                      activeTab === 'notion'
                        ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/40 shadow-xs scale-105'
                        : 'bg-zinc-900 text-zinc-400 hover:text-white border border-zinc-800'
                    }`}
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
                        index.ts
                      </span>
                      <span className="text-[10px] text-zinc-500 font-mono">VS Code</span>
                    </div>
                    {/* Code lines */}
                    <div className="p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
                      <div className="flex gap-3">
                        <span className="text-zinc-600 select-none">1</span>
                        <span><span className="text-purple-400">const</span> dictation = <span className="text-blue-400">useWhisper</span>();</span>
                      </div>
                      <div className="flex gap-3">
                        <span className="text-zinc-600 select-none">2</span>
                        <span className="text-emerald-400">// Dictated comment: Refactor global hotkey hook for Windows</span>
                      </div>
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

      {/* Streamlined High-Level Capabilities Grid */}
      <section id="capabilities" className="relative z-10 border-t border-zinc-800/60 py-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mb-14 text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Simple by Default. Extensible When Needed.
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-xs leading-relaxed text-zinc-400">
              Designed to stay completely out of your way while delivering clean, low-latency speech-to-text across Windows.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-3">
            <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-6 backdrop-blur-md transition-all hover:border-zinc-700 hover:-translate-y-1">
              <h3 className="text-base font-semibold text-white">Instant Voice Typing</h3>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                Speak into Slack, Notion, Word, or code editors. Speech is converted and pasted directly into your active input focus.
              </p>
            </div>

            <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-6 backdrop-blur-md transition-all hover:border-zinc-700 hover:-translate-y-1">
              <h3 className="text-base font-semibold text-white">Automatic Filtering</h3>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                Hesitations, stutters, and filler words (&quot;umms&quot; and &quot;ahhs&quot;) are automatically cleaned up before text appears.
              </p>
            </div>

            <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-6 backdrop-blur-md transition-all hover:border-zinc-700 hover:-translate-y-1">
              <h3 className="text-base font-semibold text-white">100% Offline Ready</h3>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                Run local Whisper models offline with GPU CUDA acceleration, or connect your choice of API key securely.
              </p>
            </div>
          </div>

          {/* Simple Concise Voice Agent Note */}
          <div className="mt-10 rounded-xl border border-zinc-800/80 bg-zinc-950 p-5 text-center text-xs text-zinc-400">
            <span className="text-zinc-200 font-semibold">Need extra automation? </span>
            <span>Enable Voice Agent mode to run smart voice actions with human approval prompts.</span>
          </div>
        </div>
      </section>

      {/* Minimal Footer */}
      <footer className="relative z-10 border-t border-zinc-900 bg-[#07080a] py-8 text-center text-[11px] text-zinc-500 font-mono">
        <div className="mx-auto max-w-6xl px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>Shuddhalekhan • Free & Open Source Desktop App</div>
          <a
            href="https://github.com/PeeeBrain/shuddhalekhan"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 hover:text-zinc-300 transition"
          >
            <svg className="size-3.5 fill-current" viewBox="0 0 1024 1024" aria-hidden="true">
              <path fillRule="evenodd" d="M512 0C229.12 0 0 229.12 0 512c0 226.56 146.56 417.92 350.08 485.76 25.6 4.48 35.2-10.88 35.2-24.32 0-12.16-.64-52.48-.64-95.36-128.64 23.68-161.92-31.36-172.16-60.16-5.76-14.72-30.72-60.16-52.48-72.32-17.92-9.6-43.52-33.28-.64-33.92 40.32-.64 69.12 37.12 78.72 52.48 46.08 77.44 119.68 55.68 149.12 42.24 4.48-33.28 17.92-55.68 32.64-68.48-113.92-12.8-232.96-56.96-232.96-252.8 0-55.68 19.84-101.76 52.48-137.6-5.12-12.8-23.04-65.28 5.12-135.68 0 0 42.88-13.44 140.8 52.48 40.96-11.52 84.48-17.28 128-17.28s87.04 5.76 128 17.28c97.92-66.56 140.8-52.48 140.8-52.48 28.16 70.4 10.24 122.88 5.12 135.68 32.64 35.84 52.48 81.28 52.48 137.6 0 196.48-119.68 240-233.6 252.8 18.56 16 34.56 46.72 34.56 94.72 0 68.48-.64 123.52-.64 140.8 0 13.44 9.6 29.44 35.2 24.32C877.44 929.92 1024 737.92 1024 512 1024 229.12 794.88 0 512 0" clipRule="evenodd" />
            </svg>
            GitHub Repository
          </a>
        </div>
      </footer>
    </div>
  );
}
