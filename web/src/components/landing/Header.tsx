import { motion, useScroll, useTransform } from 'motion/react';
import { Wordmark } from '@/components/brand/Logo';
import { Button } from '@/components/ui/button';

const NAV_LINKS = [
  { href: '#how-it-works', label: 'How it works' },
  { href: '#agent-mode', label: 'Agent mode' },
  { href: '#why-open-source', label: 'Why open source' },
];

export function Header() {
  const { scrollY } = useScroll();

  // Chrome appears only once the page is scrolled — transparent over the hero.
  const background = useTransform(scrollY, [0, 64], ['rgba(6,6,9,0)', 'rgba(6,6,9,0.78)']);
  const borderColor = useTransform(scrollY, [0, 64], ['rgba(255,255,255,0)', 'rgba(255,255,255,0.08)']);

  return (
    <motion.header
      style={{ backgroundColor: background, borderColor }}
      className="fixed inset-x-0 top-0 z-50 border-b backdrop-blur-xl"
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <a href="#" aria-label="Shuddhalekhan home" className="transition-opacity hover:opacity-80">
          <Wordmark />
        </a>

        <nav className="hidden items-center gap-8 md:flex" aria-label="Primary">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-[13px] font-medium text-muted-foreground transition-colors duration-300 hover:text-foreground"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-5">
          <a
            href="https://github.com/PeeeBrain/shuddhalekhan"
            target="_blank"
            rel="noreferrer"
            className="hidden items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors duration-300 hover:text-foreground sm:flex"
          >
            <svg className="size-4 fill-current" viewBox="0 0 1024 1024" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M512 0C229.12 0 0 229.12 0 512c0 226.56 146.56 417.92 350.08 485.76 25.6 4.48 35.2-10.88 35.2-24.32 0-12.16-.64-52.48-.64-95.36-128.64 23.68-161.92-31.36-172.16-60.16-5.76-14.72-30.72-60.16-52.48-72.32-17.92-9.6-43.52-33.28-.64-33.92 40.32-.64 69.12 37.12 78.72 52.48 46.08 77.44 119.68 55.68 149.12 42.24 4.48-33.28 17.92-55.68 32.64-68.48-113.92-12.8-232.96-56.96-232.96-252.8 0-55.68 19.84-101.76 52.48-137.6-5.12-12.8-23.04-65.28 5.12-135.68 0 0 42.88-13.44 140.8 52.48 40.96-11.52 84.48-17.28 128-17.28s87.04 5.76 128 17.28c97.92-66.56 140.8-52.48 140.8-52.48 28.16 70.4 10.24 122.88 5.12 135.68 32.64 35.84 52.48 81.28 52.48 137.6 0 196.48-119.68 240-233.6 252.8 18.56 16 34.56 46.72 34.56 94.72 0 68.48-.64 123.52-.64 140.8 0 13.44 9.6 29.44 35.2 24.32C877.44 929.92 1024 737.92 1024 512 1024 229.12 794.88 0 512 0"
                clipRule="evenodd"
              />
            </svg>
            GitHub
          </a>
          <Button asChild className="h-8 rounded-full bg-foreground px-4 text-[13px] font-semibold text-primary-foreground transition-[background-color,transform] duration-300 hover:bg-white active:scale-[0.97]">
            <a href="#download">Download</a>
          </Button>
        </div>
      </div>
    </motion.header>
  );
}
