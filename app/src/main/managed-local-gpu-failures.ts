import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { z } from 'zod';

/** At most this many remembered failures; the oldest go first. */
const KEPT = 16;

const failureSchema = z.object({
  model: z.string().min(1).max(64),
  /** The NVIDIA GPUs present, by UUID. */
  device: z.string().min(1).max(1024),
  driver: z.string().min(1).max(64),
  reason: z.string().max(1024),
  at: z.number(),
});
type Failure = z.infer<typeof failureSchema>;
export type GpuIdentity = { device: string; driver: string };

/**
 * Managed Local GPU failures remembered per model, device and driver, so Auto starts on CPU after a restart
 * instead of initializing a known-bad GPU again. A new driver or GPU, or a successful explicit GPU start, ends
 * the record. Without an identity a failure is remembered for this process only. A missing or corrupt file
 * reads as no failures, and a failed write only loses the memory, so neither can block Dictation.
 */
export function createGpuFailureRecord({ getPath, getIdentity }: {
  getPath: () => string | null;
  getIdentity: () => Promise<GpuIdentity | null>;
}) {
  let failures: Failure[] | null = null;
  const load = () => failures ??= (() => {
    const path = getPath();
    try {
      const parsed = path ? z.array(failureSchema).safeParse(JSON.parse(readFileSync(path, 'utf8'))) : null;
      return parsed?.success ? parsed.data.slice(-KEPT) : [];
    } catch { return []; }
  })();
  const save = (next: Failure[]) => {
    failures = next;
    const path = getPath();
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const staged = `${path}.${process.pid}`;
      writeFileSync(staged, JSON.stringify(next.filter(failure => failure.device)));
      renameSync(staged, path);
    } catch (error) { console.warn('Could not save the Managed Local GPU failure record:', error); }
  };
  const lookup = async (model: string) => {
    const { device, driver } = await getIdentity() ?? { device: '', driver: '' };
    const same = (failure: Failure) => failure.model === model && failure.device === device && failure.driver === driver;
    return { device, driver, same, others: load().filter(failure => !same(failure)) };
  };
  return {
    async has(model: string) { return load().some((await lookup(model)).same); },
    async record(model: string, reason: string) {
      const { device, driver, others } = await lookup(model);
      save([...others, { model, device, driver, reason: reason.slice(0, 1024), at: Date.now() }].slice(-KEPT));
    },
    async forget(model: string) {
      const { others } = await lookup(model);
      if (others.length !== load().length) save(others);
    },
  };
}
export type GpuFailureRecord = ReturnType<typeof createGpuFailureRecord>;
