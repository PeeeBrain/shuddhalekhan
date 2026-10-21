import { LatestWindowsDownloadLink } from '@/components/LatestWindowsDownloadLink';
import { Button } from '@/components/ui/button';
import { Reveal } from '@/components/motion/Reveal';
import { Wordmark } from '@/components/brand/Logo';
import { WindowsGlyph } from '@/components/landing/Hero';

const REPO = 'https://github.com/PeeeBrain/shuddhalekhan';

const FOOTER_LINKS = [
  { href: `${REPO}/releases/latest`, label: 'Releases' },
  { href: `${REPO}/issues`, label: 'Report an issue' },
  { href: REPO, label: 'GitHub' },
];

export function Cta() {
  return (
    <>
      <section id="download" className="scroll-mt-20 px-6 pt-12 pb-28 md:pb-40">
        <Reveal className="mx-auto max-w-6xl rounded-[20px] border border-border bg-card px-6 py-16 sm:px-12 md:py-24">
          <div className="flex flex-col gap-10 md:flex-row md:items-end md:justify-between">
            <h2 className="max-w-[16ch] font-display text-[clamp(2.5rem,1.5rem+4vw,4.75rem)] leading-[1] font-semibold tracking-[-0.04em] text-balance">
              Voice typing without a subscription.
            </h2>
            <div className="shrink-0">
              <Button asChild className="h-12 rounded-full px-7 text-[15px] font-semibold transition-[background-color,transform] duration-150 hover:bg-primary/90 active:scale-[0.97]">
                <LatestWindowsDownloadLink>
                  <WindowsGlyph />
                  Download for Windows
                </LatestWindowsDownloadLink>
              </Button>
              <p className="mt-3 text-[13px] text-muted-foreground">Windows 10 and 11, x64.</p>
            </div>
          </div>
        </Reveal>
      </section>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
          <Wordmark />
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
            {FOOTER_LINKS.map((link) => (
              <a key={link.label} href={link.href} target="_blank" rel="noreferrer" className="rounded-sm text-muted-foreground transition-colors duration-150 hover:text-foreground">
                {link.label}
              </a>
            ))}
          </nav>
          <p className="text-[13px] text-muted-foreground">MIT licensed</p>
        </div>
      </footer>
    </>
  );
}
