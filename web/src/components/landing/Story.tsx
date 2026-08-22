import { Reveal } from '@/components/motion/Reveal';
import { Eyebrow } from '@/components/landing/Eyebrow';

export function Story() {
  return (
    <section id="why-open-source" className="relative scroll-mt-20 py-28 md:py-36">
      <div className="mx-auto max-w-6xl px-6">
        {/* Editorial statement, Apple-keynote cadence */}
        <Reveal className="mx-auto max-w-3xl text-center">
          <Eyebrow>Why open source</Eyebrow>
          <p className="mt-6 text-balance text-2xl leading-snug font-medium tracking-[-0.01em] sm:text-3xl md:text-4xl">
            Software you talk to should work for you.{' '}
            <span className="text-muted-foreground">Not for a subscription.</span>
          </p>
        </Reveal>

        <div className="mt-16 grid gap-4 md:grid-cols-12">
          <Reveal delay={0.08} className="md:col-span-7">
            <figure className="flex h-full flex-col justify-between rounded-2xl border border-white/[0.07] bg-white/[0.02] p-8 sm:p-10">
              <blockquote className="text-lg leading-relaxed font-medium text-zinc-100 sm:text-xl">
                &ldquo;I wanted touch-free typing that could run locally, remain open source, and leave users in
                control of their data and AI providers.&rdquo;
              </blockquote>
              <figcaption className="mt-8 flex items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-xs font-semibold text-zinc-300">
                  PS
                </div>
                <div>
                  <div className="text-sm font-semibold text-white">Partha Shirolkar</div>
                  <div className="text-xs text-muted-foreground">Creator</div>
                </div>
              </figcaption>
            </figure>
          </Reveal>

          {/* The name, treated as a dictionary entry */}
          <Reveal delay={0.16} className="md:col-span-5">
            <div className="flex h-full flex-col justify-between rounded-2xl border border-white/[0.07] bg-white/[0.02] p-8 sm:p-10">
              <div>
                <div className="text-3xl font-light tracking-tight text-white">shud·dha·le·khan</div>
                <div className="mt-2 font-mono text-xs text-voice">/ʃud̪ˑʱəleˑkʰən/ · शुद्धलेखन</div>
              </div>
              <div className="mt-14 border-t border-white/[0.06] pt-5">
                <div className="font-mono text-[10px] tracking-[0.2em] text-zinc-500 uppercase">Marathi origin</div>
                <p className="mt-2.5 text-sm leading-relaxed text-zinc-300">
                  <strong className="font-semibold text-white">&ldquo;Correct writing.&rdquo;</strong> Words written
                  accurately, with grammar, spelling, and pronunciation intact.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
