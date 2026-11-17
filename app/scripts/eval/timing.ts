// Lines up the app's SHUDDHALEKHAN_TIMING_LOG marks (src/main/eval-timing.ts) with the e2e rig's own
// press/release/observed times. Both sides read the same monotonic clock in nanoseconds.

export type Mark = { event: string; ns: string; acceptedEvents?: number };
export type ClipClock = { id: string; pressNs: string; releaseNs: string; observedNs: string | null };

export type ClipTimings = {
  hotkeyToPillMs: number | null;
  hotkeyToCaptureReadyMs: number | null;
  releaseToTranscriptMs: number | null;
  /** SendInput accepted the paste chord; the target may still have ignored it. */
  releaseToPasteDispatchMs: number | null;
  /** The rig's text box actually changed: what the user sees. */
  releaseToObservedInsertMs: number | null;
  releaseToClipboardRestoredMs: number | null;
  pasteAcceptedEvents: number | null;
};

export function parseMarks(log: string): Mark[] {
  return log.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Mark);
}

const ms = (from: string, to: string | null | undefined) =>
  to == null ? null : Number(BigInt(to) - BigInt(from)) / 1e6;

/**
 * A mark belongs to the clip whose hotkey press came last before it, and must fall on the right side of
 * that clip's release: start marks before it, delivery marks after. The first mark of each event wins, so a
 * late mark from a previous clip is dropped rather than read as this clip's. When the previous clip never
 * showed text, its delivery may still be in flight, so this clip's delivery marks are left unattributed.
 */
export function correlate(clips: ClipClock[], marks: Mark[]): ClipTimings[] {
  return clips.map((clip, index) => {
    const press = BigInt(clip.pressNs);
    const release = BigInt(clip.releaseNs);
    const end = index + 1 < clips.length ? BigInt(clips[index + 1].pressNs) : null;
    const previousStalled = index > 0 && clips[index - 1].observedNs === null;
    const first = (event: string, from: bigint, to: bigint | null) =>
      marks.find((mark) => mark.event === event && BigInt(mark.ns) >= from && (to === null || BigInt(mark.ns) < to));
    const started = (event: string) => ms(clip.pressNs, first(event, press, release)?.ns);
    const delivered = (event: string) => ms(clip.releaseNs, previousStalled ? undefined : first(event, release, end)?.ns);
    const dispatch = previousStalled ? undefined : first('paste-dispatched', release, end);
    return {
      hotkeyToPillMs: started('pill-shown'),
      hotkeyToCaptureReadyMs: started('capture-ready'),
      releaseToTranscriptMs: delivered('transcript'),
      releaseToPasteDispatchMs: ms(clip.releaseNs, dispatch?.ns),
      releaseToObservedInsertMs: ms(clip.releaseNs, clip.observedNs),
      releaseToClipboardRestoredMs: delivered('clipboard-restored'),
      pasteAcceptedEvents: dispatch?.acceptedEvents ?? null,
    };
  });
}

// Below these counts a median or tail is noise; report the count and leave the statistic out.
export const MIN_SAMPLES_FOR_MEDIAN = 10;
export const MIN_SAMPLES_FOR_TAIL = 20;

function quantile(sorted: number[], q: number): number {
  const index = (sorted.length - 1) * q;
  const low = Math.floor(index);
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
}

export function summarize(values: (number | null)[]) {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  return {
    n: sorted.length,
    missing: values.length - sorted.length,
    p50: sorted.length >= MIN_SAMPLES_FOR_MEDIAN ? quantile(sorted, 0.5) : null,
    p95: sorted.length >= MIN_SAMPLES_FOR_TAIL ? quantile(sorted, 0.95) : null,
  };
}
