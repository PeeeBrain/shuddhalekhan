import { motion, useReducedMotion } from 'motion/react';
import { LatestWindowsDownloadLink } from '@/components/LatestWindowsDownloadLink';
import { DictationDemo } from '@/components/landing/DictationDemo';
import { Button } from '@/components/ui/button';

const EASE_OUT_QUART = [0.25, 1, 0.5, 1] as const;

export function WindowsGlyph() {
  return (
    <svg className="fill-current" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M0 0h7.5v7.5H0V0zm8.5 0H16v7.5H8.5V0zM0 8.5h7.5V16H0V8.5zm8.5 0H16V16H8.5V8.5z" />
    </svg>
  );
}

export function Hero() {
  const reduceMotion = useReducedMotion();
  const enter = (delay: number) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, y: 20 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.7, delay, ease: EASE_OUT_QUART },
        };

  return (
    <section className="pt-32 pb-24 md:pt-40 md:pb-32">
      <div className="mx-auto max-w-6xl px-6">
        <motion.h1
          {...enter(0)}
          className="font-display text-[clamp(3rem,1.6rem+4.6vw,5.25rem)] leading-[0.98] font-semibold tracking-[-0.045em] text-balance"
        >
          Voice typing for Windows.
          <span className="block text-muted-foreground">Free and open source.</span>
        </motion.h1>

        <motion.div {...enter(0.08)} className="mt-10 grid items-end gap-x-12 gap-y-8 lg:grid-cols-12">
          <p className="max-w-[46ch] text-[17px] leading-relaxed text-muted-foreground text-pretty lg:col-span-6">
            Press your shortcut and talk. When you finish, Shuddhalekhan types what you said into the app you're using.
            Speech recognition runs on your PC, or with a provider you pick.
          </p>
          <div className="lg:col-span-5 lg:col-start-8 lg:justify-self-end">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
              <Button asChild className="h-11 rounded-full px-6 text-[15px] font-semibold transition-[background-color,transform] duration-150 hover:bg-primary/90 active:scale-[0.97]">
                <LatestWindowsDownloadLink>
                  <WindowsGlyph />
                  Download for Windows
                </LatestWindowsDownloadLink>
              </Button>
              <a
                href="https://github.com/PeeeBrain/shuddhalekhan"
                target="_blank"
                rel="noreferrer"
                className="rounded-sm text-[15px] font-medium text-voice transition-opacity duration-150 hover:opacity-80"
              >
                View on GitHub ›
              </a>
            </div>
            <p className="mt-4 text-[13px] text-muted-foreground">Windows 10 and 11. MIT license.</p>
          </div>
        </motion.div>

        <motion.div {...enter(0.16)} className="mt-16 md:mt-20">
          <DictationDemo />
        </motion.div>
      </div>
    </section>
  );
}
