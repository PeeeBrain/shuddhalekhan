import { cn } from '@/lib/utils';

/**
 * Shuddhalekhan mark: voice bars resolving into a written line.
 * Drawn as SVG so it scales from favicon to footer without raster artifacts.
 */
export function Logomark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('size-9', className)} aria-hidden="true">
      <defs>
        <linearGradient id="logo-voice" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a7b0ff" />
          <stop offset="1" stopColor="#7c8aff" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="#101120" />
      <rect x="0.5" y="0.5" width="63" height="63" rx="15.5" fill="none" stroke="#8592ff" strokeOpacity="0.35" />
      <rect x="13" y="26" width="5" height="12" rx="2.5" fill="url(#logo-voice)" />
      <rect x="22" y="20" width="5" height="24" rx="2.5" fill="url(#logo-voice)" />
      <rect x="31" y="24" width="5" height="16" rx="2.5" fill="url(#logo-voice)" />
      <rect x="42" y="27" width="10" height="3" rx="1.5" fill="#f5f5f7" />
      <rect x="42" y="34" width="7" height="3" rx="1.5" fill="#f5f5f7" fillOpacity="0.55" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <Logomark className="size-8" />
      <span className="text-[15px] font-semibold tracking-tight text-foreground">Shuddhalekhan</span>
    </span>
  );
}
