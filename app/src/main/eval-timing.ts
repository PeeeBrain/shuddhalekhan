import { appendFileSync } from 'fs';

const logPath = process.env.SHUDDHALEKHAN_TIMING_LOG;

/**
 * Opt-in Dictation lifecycle marks for scripts/eval/e2e-rig.ps1. Each mark is one JSON line stamped with
 * process.hrtime, the system-wide monotonic clock (QueryPerformanceCounter on Windows, CLOCK_MONOTONIC on
 * Linux), so the rig can line marks up with its own keystrokes. A no-op unless SHUDDHALEKHAN_TIMING_LOG is set.
 */
export function markTiming(event: string, detail?: Record<string, unknown>): void {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${JSON.stringify({ event, ns: String(process.hrtime.bigint()), ...detail })}\n`);
  } catch {
    // Measurement must never break Dictation.
  }
}
