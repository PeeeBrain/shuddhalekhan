import type { SaveToastState } from './use-settings-persistence';

interface SaveToastProps {
  toast: SaveToastState | null;
}

export function SaveToast({ toast }: SaveToastProps) {
  if (!toast) return null;

  const toneClass =
    toast.tone === 'error'
      ? 'border-l-destructive'
      : 'border-l-primary';

  return (
    <div
      key={toast.key}
      role="status"
      aria-live="polite"
      className={`pointer-events-none absolute bottom-5 right-5 z-40 rounded-md border border-border border-l-2 bg-popover px-4 py-2.5 text-sm text-popover-foreground shadow-lg save-toast-enter ${toneClass}`}
    >
      {toast.message}
    </div>
  );
}