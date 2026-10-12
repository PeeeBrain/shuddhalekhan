import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SectionHeaderProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** Page title for a settings section. */
export function SectionHeader({ title, description, actions, className }: SectionHeaderProps) {
  return (
    <header className={cn('mb-7 flex shrink-0 items-end justify-between gap-6', className)}>
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-xl text-[13px] leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </header>
  );
}

type SettingsPanelProps = ComponentPropsWithoutRef<'section'>;

/** A titled group: SettingsPanelHeader followed by a SettingsCard of rows. */
export function SettingsPanel({ className, children, ...props }: SettingsPanelProps) {
  return (
    <section {...props} className={cn('settings-panel', className)}>
      {children}
    </section>
  );
}

/** Rounded surface that holds divided rows. */
export function SettingsCard({ className, children, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div {...props} className={cn('settings-card', className)}>
      {children}
    </div>
  );
}

interface SettingsPanelHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
  id?: string;
}

export function SettingsPanelHeader({
  title,
  description,
  actions,
  className,
  id,
}: SettingsPanelHeaderProps) {
  return (
    <header className={cn('flex items-end justify-between gap-4 px-1', className)}>
      <div className="min-w-0">
        <h3 id={id} className="text-[13px] font-medium text-muted-foreground">{title}</h3>
        {description ? (
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground/80">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </header>
  );
}
