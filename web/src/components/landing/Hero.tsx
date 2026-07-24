import { useState, useEffect } from 'react';
import { ArrowRight, Check } from 'lucide-react';

const TYPEWRITER_PHRASES = [
  'Hey Sarah, just pushed the fix for the authentication bug to staging. Can you take a look when you get a chance?',
  '// Todo: Optimize local database query and add automatic retry logic for failed network requests.',
  'Hi Alex, thanks for the quick call today. I have updated the project proposal with the timeline we agreed on.',
  'Key takeaways from today: prioritize user feedback, ship the Windows installer update, and review release notes.',
];

const formatTimer = (s: number) => {
  const mins = Math.floor(s / 60).toString().padStart(2, '0');
  const secs = (s % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
};

export function Hero() {
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

  return (
    <section className="relative z-10 mx-auto max-w-5xl px-6 pt-18 pb-14 text-center md:pt-24">
      <h1 className="mx-auto max-w-4xl text-balance text-4xl font-semibold tracking-tight text-white sm:text-6xl md:text-7xl leading-[1.08]">
        Voice dictation for Windows.
      </h1>

      <p className="mx-auto mt-6 max-w-2xl text-balance text-base leading-relaxed text-zinc-300 sm:text-lg">
        Speak into any app. Run Whisper locally or bring your own API key. Free and open source, with no monthly subscription.
      </p>

      {/* Single Primary Action Row with Official Windows Logo SVG */}
      <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <a
          href="https://github.com/PeeeBrain/shuddhalekhan/releases/latest"
          target="_blank"
          rel="noreferrer"
          className="flex h-12 items-center gap-2.5 rounded-full bg-zinc-100 px-7 text-sm font-semibold text-zinc-950 shadow-xl transition hover:bg-white active:scale-95 hover:shadow-indigo-500/20"
        >
          <svg className="size-3.5 fill-current text-zinc-950" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M0 0h7.5v7.5H0V0zm8.5 0H16v7.5H8.5V0zM0 8.5h7.5V16H0V8.5zm8.5 0H16V16H8.5V8.5z" />
          </svg>
          Download for Windows
        </a>
        <a
          href="#demo"
          className="flex h-12 items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900/60 px-6 text-sm font-semibold text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-900 hover:text-white"
        >
          See it in action
          <ArrowRight className="size-4" />
        </a>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[11px] text-zinc-500">
        {['No subscription', 'Works offline', 'Windows 10/11 · x64'].map((item) => (
          <span key={item} className="flex items-center gap-1.5"><Check className="size-3 text-emerald-400" />{item}</span>
        ))}
      </div>

      {/* Authentic Windows 11 Desktop Showcase Frame with Gentle Floating Micro-Animation */}
      <div id="demo" className="mt-12 scroll-mt-24 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl transition-transform duration-500 hover:-translate-y-1 hover:shadow-indigo-500/10">
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
            <div className="flex items-center gap-4 rounded-full border border-white/15 bg-[#141526]/95 px-6 py-3 shadow-2xl backdrop-blur-2xl transition-[border-color,box-shadow] hover:border-indigo-400/40 hover:shadow-indigo-500/20">
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
                    className="w-[3px] rounded-full bg-white transition-[height] duration-300 ease-in-out shadow-[0_0_6px_rgba(133,146,255,0.6)]"
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
      <p className="mt-4 text-sm text-zinc-400">
        Press the global shortcut, speak naturally, and clean text appears at your active cursor.
      </p>
    </section>
  );
}
