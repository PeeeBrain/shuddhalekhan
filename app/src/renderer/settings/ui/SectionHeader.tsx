import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SectionHeaderProps {
  title: string;
  description?: string;
  eyebrow?: string;
  className?: string;
}

export function SectionHeader({ title, description, eyebrow, className }: SectionHeaderProps) {
  return (
    <header className={cn('mb-6 shrink-0', className)}>
      {eyebrow ? (
        <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{eyebrow}</p>
      ) : null}
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {description ? (
        <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      ) : null}
    </header>
  );
}

type SettingsPanelProps = ComponentPropsWithoutRef<'section'>;

export function SettingsPanel({ className, children, ...props }: SettingsPanelProps) {
  return (
    <section {...props} className={cn('settings-panel', className)}>
      {children}
    </section>
  );
}

interface SettingsPanelHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
  id?: string;
}

export function SettingsPanelHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
  id,
}: SettingsPanelHeaderProps) {
  return (
    <header className={cn('flex flex-col gap-1.5', className)}>
      {eyebrow ? (
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{eyebrow}</p>
      ) : null}
      <div className="flex items-start justify-between gap-4">
        <h3 id={id} className="text-sm font-semibold text-foreground">{title}</h3>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      {description ? (
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      ) : null}
    </header>
  );
}
