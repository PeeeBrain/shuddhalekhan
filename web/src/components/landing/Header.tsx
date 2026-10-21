import { Wordmark } from '@/components/brand/Logo';
import { Button } from '@/components/ui/button';

const NAV_LINKS = [
  { href: '#dictation', label: 'Dictation' },
  { href: '#agent-mode', label: 'Agent Mode' },
  { href: '#providers', label: 'Providers' },
];

/* Translucent bar: content scrolls under it; solid when transparency is reduced. */
export function Header() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-border/50 bg-background/75 backdrop-blur-xl backdrop-saturate-150 [@media(prefers-reduced-transparency:reduce)]:bg-background [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <a href="#" aria-label="Shuddhalekhan home" className="rounded-sm">
          <Wordmark />
        </a>

        <nav className="hidden items-center gap-8 md:flex" aria-label="Primary">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-sm text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
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
            className="hidden rounded-sm text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground sm:block"
          >
            GitHub
          </a>
          <Button asChild size="sm" className="h-8 rounded-full px-4 text-[13px] font-semibold transition-[background-color,transform] duration-150 hover:bg-primary/90 active:scale-[0.97]">
            <a href="#download">Download</a>
          </Button>
        </div>
      </div>
    </header>
  );
}
