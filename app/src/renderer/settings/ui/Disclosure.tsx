import { useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

interface DisclosureProps extends ComponentPropsWithoutRef<'div'> {
  label: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

/** Collapsible settings block — the app's single disclosure idiom (button + chevron). */
export function Disclosure({ label, defaultOpen = false, children, className, ...props }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className} {...props}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="text-sm font-medium">{label}</span>
        <ChevronDown
          aria-hidden
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open ? children : null}
    </div>
  );
}
