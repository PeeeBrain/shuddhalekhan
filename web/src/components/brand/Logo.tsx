import { cn } from '@/lib/utils';

/** Same mark as the desktop app (app/icons/tray-icon.ico), exported to public/icon.png. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <img src="/icon.png" alt="" width={28} height={28} className="size-7" />
      <span className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Shuddhalekhan</span>
    </span>
  );
}
