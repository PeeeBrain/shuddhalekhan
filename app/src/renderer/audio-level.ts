const listeners = new Set<(level: number) => void>();

export function publishAudioLevel(level: number): void {
  for (const listener of listeners) listener(level);
}

export function subscribeAudioLevel(listener: (level: number) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Frequency bands the recording pill shows, low to high. */
export const BAND_COUNT = 8;
const BAND_LOW_HZ = 90;
const BAND_HIGH_HZ = 7000;
/** How far below the loudest band a band still shows; quieter ones rest on the line. */
const BAND_RANGE_DB = 30;
/** Speech falls off with frequency; this per-band lift lets sibilants reach the field's ends. */
const BAND_TILT_DB = 3.5;

/**
 * Folds an analyser's dB spectrum (`binHz` apart) into BAND_COUNT log-spaced
 * voice bands, each the loudest bin in its range. Bands are relative to the
 * loudest one (which is 1), so they carry the voice's shape whatever the mic
 * gain; the caller scales them by loudness.
 */
export function bandsFromSpectrum(db: Float32Array, binHz: number, out: Float32Array): void {
  const ratio = BAND_HIGH_HZ / BAND_LOW_HZ;
  let loudest = -Infinity;
  for (let band = 0; band < BAND_COUNT; band++) {
    const first = Math.ceil((BAND_LOW_HZ * ratio ** (band / BAND_COUNT)) / binHz);
    const last = Math.max(first, Math.ceil((BAND_LOW_HZ * ratio ** ((band + 1) / BAND_COUNT)) / binHz) - 1);
    let peak = -Infinity;
    for (let bin = first; bin <= Math.min(last, db.length - 1); bin++) peak = Math.max(peak, db[bin]);
    out[band] = peak + band * BAND_TILT_DB;
    loudest = Math.max(loudest, out[band]);
  }
  for (let band = 0; band < BAND_COUNT; band++) {
    out[band] = Number.isFinite(loudest) ? Math.max(0, 1 - (loudest - out[band]) / BAND_RANGE_DB) : 0;
  }
}

let bandReader: ((out: Float32Array) => boolean) | null = null;

/** The live capture installs this while recording (the pill preview installs a synthetic one). */
export function setBandReader(reader: ((out: Float32Array) => boolean) | null): void {
  bandReader = reader;
}

/** Fills `out` with the mic's current bands; false when nothing is capturing. */
export function readBands(out: Float32Array): boolean {
  return bandReader?.(out) ?? false;
}
