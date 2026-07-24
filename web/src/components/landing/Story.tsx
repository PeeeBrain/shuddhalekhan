export function Story() {
  return (
    <section id="story" className="relative z-10 scroll-mt-20 border-t border-zinc-800/60 py-20">
      <div className="mx-auto grid max-w-6xl gap-6 px-6 md:grid-cols-12">
        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-8 md:col-span-7">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-full border border-indigo-500/40 bg-indigo-600/20 text-xs font-semibold text-indigo-200">PS</div>
            <div><div className="text-sm font-semibold text-white">Why I built Shuddhalekhan</div><div className="text-xs text-zinc-500">Partha Shirolkar · Creator</div></div>
          </div>
          <blockquote className="mt-7 max-w-2xl text-xl font-medium leading-relaxed text-zinc-100 sm:text-2xl">
            “I wanted touch-free typing that could run locally, remain open source, and leave users in control of their data and AI providers.”
          </blockquote>
          <p className="mt-5 max-w-2xl text-sm leading-relaxed text-zinc-400">
            Shuddhalekhan began as an offline-first alternative to subscription dictation tools. It is growing into a customizable voice interface without losing that original promise: your workflow, your providers, your control.
          </p>
        </div>

        <div className="flex flex-col justify-between rounded-2xl border border-zinc-800/80 bg-[#0b0c11] p-8 md:col-span-5">
          <div>
            <div className="font-serif text-2xl font-semibold tracking-wide text-white">shud·dha·le·khan</div>
            <div className="mt-1 font-mono text-xs text-indigo-300">/ʃud̪ˑʱəleˑkʰən/ · शुद्धलेखन</div>
          </div>
          <div className="mt-16 border-t border-zinc-800 pt-5">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">Marathi origin</div>
            <p className="mt-2 text-sm leading-relaxed text-zinc-300"><strong className="font-semibold text-white">“Correct writing”</strong> — writing words accurately according to grammar, spelling, and phonetic purity.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
