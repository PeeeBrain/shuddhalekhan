// From AI Elements (https://ui.shadcn.com/docs/ai-elements), trimmed to the parts the Agent card uses.
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { ChevronDownIcon, DotIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

export function ChainOfThought({ className, ...props }: ComponentProps<typeof Collapsible>) {
  return <Collapsible className={cn('group/cot w-full', className)} {...props} />;
}

export function ChainOfThoughtHeader({ className, children, ...props }: ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger
      className={cn('flex w-full items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground', className)}
      {...props}
    >
      <span className="flex-1 text-left">{children}</span>
      <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]/cot:rotate-180" aria-hidden />
    </CollapsibleTrigger>
  );
}

export function ChainOfThoughtContent({ className, ...props }: ComponentProps<typeof CollapsibleContent>) {
  return <CollapsibleContent className={cn('mt-2 space-y-2', className)} {...props} />;
}

const stepStatusStyles = {
  active: 'text-foreground',
  complete: 'text-muted-foreground',
};

export function ChainOfThoughtStep({ className, icon: Icon = DotIcon, label, status = 'complete', ...props }: ComponentProps<'div'> & {
  icon?: LucideIcon;
  label: ReactNode;
  status?: keyof typeof stepStatusStyles;
}) {
  return (
    <div className={cn('flex gap-2 text-xs leading-5', stepStatusStyles[status], className)} {...props}>
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 break-words">{label}</div>
    </div>
  );
}
