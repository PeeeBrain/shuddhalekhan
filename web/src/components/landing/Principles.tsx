import { useRef } from 'react';
import { useInView } from 'motion/react';
import { Cpu, Plug } from 'lucide-react';
import { Reveal } from '@/components/motion/Reveal';

/* Logos from svgl.app (dark variants), saved under public/logos. */
type Provider = { name: string; logo?: string; icon?: typeof Cpu };

const ROWS: { use: string; reverse?: boolean; providers: Provider[] }[] = [
  {
    use: 'Speech to text',
    providers: [
      { name: 'NVIDIA Parakeet, on your PC', logo: 'nvidia' },
      { name: 'whisper.cpp', icon: Cpu },
      { name: 'OpenAI', logo: 'openai' },
      { name: 'Azure Speech', logo: 'azure' },
      { name: 'Google Cloud', logo: 'google-cloud' },
      { name: 'NVIDIA NIM', logo: 'nvidia' },
      { name: 'Any compatible endpoint', icon: Plug },
    ],
  },
  {
    use: 'Agent Mode',
    reverse: true,
    providers: [
      { name: 'OpenAI', logo: 'openai' },
      { name: 'Azure OpenAI', logo: 'azure' },
      { name: 'OpenRouter', logo: 'openrouter' },
      { name: 'Ollama', logo: 'ollama' },
      { name: 'Any OpenAI-compatible endpoint', icon: Plug },
    ],
  },
];

export function Principles() {
  return (
    <section id="providers" className="scroll-mt-20 py-24 md:py-36">
      <div className="mx-auto max-w-6xl px-6">
        <Reveal className="max-w-2xl">
          <h2 className="font-display text-[clamp(2.25rem,1.5rem+2.8vw,3.75rem)] leading-[1.02] font-semibold tracking-[-0.035em] text-balance">
            Bring your own models.
          </h2>
          <p className="mt-6 max-w-[46ch] text-[17px] leading-relaxed text-muted-foreground text-pretty">
            Run speech recognition on your PC, or use providers you already pay for. No account and no telemetry.
          </p>
        </Reveal>

        <Reveal delay={0.08} className="mt-14">
          <dl className="space-y-8">
            {ROWS.map((row) => (
              <div key={row.use} className="grid items-center gap-x-8 gap-y-3 md:grid-cols-[9rem_1fr]">
                <dt className="text-[13px] font-medium text-muted-foreground">{row.use}</dt>
                <dd className="min-w-0">
                  <Marquee providers={row.providers} reverse={row.reverse} />
                </dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </div>
    </section>
  );
}

/**
 * Infinite logo strip: the list renders twice and the track slides by half its width.
 * Transform-only, paused off-screen and on hover, static under reduced motion.
 */
function Marquee({ providers, reverse }: { providers: Provider[]; reverse?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);

  return (
    <div ref={ref} className="marquee overflow-hidden" data-paused={!inView}>
      <div className="marquee-track flex w-max" data-reverse={reverse}>
        {[0, 1].map((copy) => (
          <ul key={copy} aria-hidden={copy === 1} className="flex shrink-0 items-center gap-10 pr-10">
            {providers.map(({ name, logo, icon: Icon }) => (
              <li key={name} className="flex items-center gap-3 text-[clamp(1.0625rem,1rem+0.3vw,1.25rem)] font-medium whitespace-nowrap">
                {logo ? (
                  <img src={`/logos/${logo}.svg`} alt="" width={24} height={24} className="size-6 object-contain" />
                ) : Icon ? (
                  <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
                ) : null}
                {name}
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}
