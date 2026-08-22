import { cn } from '@/lib/utils';

/** Mono uppercase section label — periwinkle for dictation, coral for agent mode. */
export function Eyebrow({ tone = 'voice', children }: { tone?: 'voice' | 'agent'; children: string }) {
  return (
    <p className={cn('font-mono text-[11px] font-medium tracking-[0.24em] uppercase', tone === 'agent' ? 'text-agent' : 'text-voice')}>
      {children}
    </p>
  );
}
