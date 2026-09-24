import type { SaveToastState } from './use-settings-persistence';

interface SaveToastProps {
  toast: SaveToastState | null;
}

export function SaveToast({ toast }: SaveToastProps) {
  if (!toast) return null;

  const isError = toast.tone === 'error';

  return (
    <div
      key={toast.key}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={`pointer-events-none absolute bottom-5 right-5 z-40 max-w-[min(360px,calc(100vw-2rem))] rounded-lg border border-border bg-popover px-3.5 py-2.5 text-sm text-popover-foreground shadow-lg border-l-2 save-toast-enter ${
        isError ? 'border-l-destructive' : 'border-l-primary'
      }`}
    >
      {toast.message}
    </div>
  );
}
