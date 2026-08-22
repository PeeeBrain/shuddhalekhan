import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { useRef } from 'react';
import { LatestWindowsDownloadLink } from '@/components/LatestWindowsDownloadLink';
import { Button } from '@/components/ui/button';
import { Reveal } from '@/components/motion/Reveal';
import { Logomark } from '@/components/brand/Logo';

export function Cta() {
  const sectionRef = useRef<HTMLElement>(null);
  const reduceMotion = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: sectionRef, offset: ['start end', 'start center'] });

  // The closing glow gathers strength as the CTA approaches.
  const glowOpacity = useTransform(scrollYProgress, [0, 1], [0.25, 1]);

  return (
    <>
      <section id="download" ref={sectionRef} className="relative scroll-mt-20 overflow-hidden px-6 py-32 md:py-44">
        <motion.div
          aria-hidden="true"
          style={{ opacity: reduceMotion ? 1 : glowOpacity }}
          className="pointer-events-none absolute top-[-180px] left-1/2 h-[520px] w-[900px] -translate-x-1/2 bg-[radial-gradient(closest-side,rgba(133,146,255,0.16),transparent)]"
        />

        <Reveal className="relative mx-auto max-w-2xl text-center">
          <p className="font-mono text-[11px] font-medium tracking-[0.24em] text-voice uppercase">
            Your computer. Your rules.
          </p>
          <h2 className="mt-5 text-balance text-4xl font-semibold tracking-[-0.03em] sm:text-6xl">
            Stop paying monthly to type with your voice.
          </h2>
          <p className="mx-auto mt-5 max-w-md text-pretty leading-relaxed text-muted-foreground">
            Download Shuddhalekhan, point it at a Whisper server, and start dictating in any app. Free and open
            source.
          </p>
          <Button
            asChild
            className="mx-auto mt-9 h-12 rounded-full bg-foreground px-8 text-sm font-semibold text-primary-foreground transition-[background-color,transform] duration-300 hover:bg-white active:scale-[0.98]"
          >
            <LatestWindowsDownloadLink>Download for Windows</LatestWindowsDownloadLink>
          </Button>
          <div className="mt-4 font-mono text-[11px] text-zinc-500">Windows 10 / 11 · x64 · installer auto-updates</div>
        </Reveal>
      </section>

      <footer className="relative border-t border-white/[0.06]">
        <div className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-14 md:flex-row md:items-start md:justify-between">
          <div className="max-w-xs">
            <Logomark className="size-8" />
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
              Free &amp; open source voice dictation for Windows. Speak freely.
            </p>
          </div>

          <nav className="flex gap-16" aria-label="Footer">
            <div>
              <div className="font-mono text-[10px] tracking-[0.2em] text-zinc-500 uppercase">Project</div>
              <ul className="mt-4 space-y-2.5 text-sm">
                <li><a className="text-zinc-300 transition-colors hover:text-white" href="https://github.com/PeeeBrain/shuddhalekhan/releases/latest" target="_blank" rel="noreferrer">Releases</a></li>
                <li><a className="text-zinc-300 transition-colors hover:text-white" href="https://github.com/PeeeBrain/shuddhalekhan/issues" target="_blank" rel="noreferrer">Report an issue</a></li>
                <li><a className="text-zinc-300 transition-colors hover:text-white" href="https://github.com/PeeeBrain/shuddhalekhan" target="_blank" rel="noreferrer">GitHub</a></li>
              </ul>
            </div>
            <div>
              <div className="font-mono text-[10px] tracking-[0.2em] text-zinc-500 uppercase">Page</div>
              <ul className="mt-4 space-y-2.5 text-sm">
                <li><a className="text-zinc-300 transition-colors hover:text-white" href="#how-it-works">How it works</a></li>
                <li><a className="text-zinc-300 transition-colors hover:text-white" href="#agent-mode">Agent mode</a></li>
                <li><a className="text-zinc-300 transition-colors hover:text-white" href="#why-open-source">Why open source</a></li>
              </ul>
            </div>
          </nav>
        </div>

        <div className="border-t border-white/[0.05]">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 py-6 font-mono text-[11px] text-zinc-600 sm:flex-row">
            <span>Shuddhalekhan · MIT licensed</span>
            <span>शुद्धलेखन · correct writing</span>
          </div>
        </div>
      </footer>
    </>
  );
}
