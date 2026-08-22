import { KeyRound, ScrollText, WifiOff } from 'lucide-react';
import { Reveal } from '@/components/motion/Reveal';
import { Eyebrow } from '@/components/landing/Eyebrow';

const PRINCIPLES = [
  {
    icon: WifiOff,
    title: 'Local by default',
    text: 'Run Whisper on your own machine and dictation works with the network unplugged. Audio goes nowhere else unless you point it at a cloud endpoint.',
  },
  {
    icon: KeyRound,
    title: 'Your keys, your providers',
    text: 'Bring any OpenAI-compatible endpoint for Agent Mode. API keys live in environment variables. Config stores their names, never their values.',
  },
  {
    icon: ScrollText,
    title: 'Everything on the record',
    text: 'Shuddhalekhan records every agent run, tool call, and approval in a SQLite database on your disk. Nothing goes to a remote service.',
  },
];

export function Principles() {
  return (
    <section id="principles" className="relative scroll-mt-20 py-28 md:py-36">
      <div className="mx-auto max-w-6xl px-6">
        <Reveal className="mx-auto max-w-2xl text-center">
          <Eyebrow>Privacy</Eyebrow>
          <h2 className="mt-4 text-balance text-3xl font-semibold tracking-[-0.02em] sm:text-5xl">
            It only talks to servers you choose.
          </h2>
        </Reveal>

        <div className="mt-14 grid gap-4 md:grid-cols-3">
          {PRINCIPLES.map(({ icon: Icon, title, text }, i) => (
            <Reveal key={title} delay={0.08 + i * 0.08} className="h-full">
              <article className="group h-full rounded-2xl border border-white/[0.07] bg-white/[0.02] p-7 transition-colors duration-500 hover:border-white/[0.14] hover:bg-white/[0.035]">
                <div className="flex size-10 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03] transition-colors duration-500 group-hover:border-voice/30">
                  <Icon className="size-4.5 text-voice" aria-hidden="true" />
                </div>
                <h3 className="mt-5 text-base font-semibold text-white">{title}</h3>
                <p className="mt-2.5 text-[13px] leading-relaxed text-muted-foreground">{text}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
