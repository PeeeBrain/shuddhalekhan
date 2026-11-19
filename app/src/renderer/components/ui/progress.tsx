import { cn } from "@/lib/utils"

/** Determinate download bar. `value` is 0–100; the fill only moves when progress events arrive. */
function Progress({ value, label, className }: { value: number; label: string; className?: string }) {
  const percent = Math.min(100, Math.max(0, Math.round(value)))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className="h-full w-full rounded-full bg-primary transition-transform duration-200 ease-out"
        style={{ transform: `translateX(${percent - 100}%)` }}
      />
    </div>
  )
}

export { Progress }
