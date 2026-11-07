import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 16 kHz mono PCM16, the one canonical capture format. */
export const SPOOL_SAMPLE_RATE = 16_000;
/** Largest single IPC chunk accepted; the renderer sends ~20 ms (640 B) batches. */
export const MAX_SPOOL_CHUNK_BYTES = 64 * 1024;
/** Largest even data size a WAV header can describe: RIFF sizes are uint32 and include 36 header bytes. */
const MAX_WAV_DATA_BYTES = 0xffff_ffff - 37;

const FILE_PREFIX = 'capture-';

/** Per-user so a shared temp dir cannot be squatted for everyone; validated before every use. */
export function defaultSpoolDir(): string {
  return join(tmpdir(), `shuddhalekhan-audio-${process.getuid?.() ?? 'user'}`);
}

/**
 * Creates `dir` owner-only, or accepts an existing one only if it is a real
 * directory (not a symlink) owned by this user with no group/other access.
 * Owner/mode checks are POSIX-only; Windows temp is already per-user.
 */
function ensurePrivateDir(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stats = lstatSync(dir);
  const uid = process.getuid?.();
  if (!stats.isDirectory() || (uid !== undefined && (stats.uid !== uid || (stats.mode & 0o077) !== 0))) {
    throw new Error(`Refusing unsafe audio spool directory ${dir}.`);
  }
}

/**
 * One recording's PCM, appended in renderer order to a private temp file so
 * long recordings never sit in memory. `finish` verifies the renderer's
 * declared end boundary before materializing the WAV; any gap fails.
 */
export class AudioSpool {
  private fd: number | null;
  private chunks = 0;
  private bytes = 0;

  private constructor(readonly path: string) {
    this.fd = openSync(path, 'wx+', 0o600);
  }

  static open(dir = defaultSpoolDir()): AudioSpool {
    ensurePrivateDir(dir);
    return new AudioSpool(join(dir, `${FILE_PREFIX}${process.pid}-${randomUUID()}.pcm`));
  }

  /** Throws on a sequence gap, malformed chunk, WAV size overflow, or write failure (e.g. ENOSPC). */
  append(chunkSequence: number, pcm: Uint8Array): void {
    if (this.fd === null) throw new Error('Audio spool is closed.');
    if (chunkSequence !== this.chunks) {
      throw new Error(`Audio chunk ${chunkSequence} arrived, expected ${this.chunks}.`);
    }
    if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0 || pcm.byteLength > MAX_SPOOL_CHUNK_BYTES) {
      throw new Error(`Audio chunk ${chunkSequence} has an invalid size.`);
    }
    if (this.bytes + pcm.byteLength > MAX_WAV_DATA_BYTES) {
      throw new Error('Recording is longer than a WAV file can hold.');
    }
    // shortcut: sync append on main (~640 B per 20 ms, bounded by the renderer's write credits); move to a write stream if profiling shows main stalls.
    let written = 0;
    while (written < pcm.byteLength) {
      const count = writeSync(this.fd, pcm, written, pcm.byteLength - written, this.bytes + written);
      if (count === 0) throw new Error('Audio spool write made no progress.');
      written += count;
    }
    this.bytes += pcm.byteLength;
    this.chunks += 1;
  }

  /** Verifies the end boundary, returns a 16 kHz mono WAV, and deletes the file. */
  finish(chunkCount: number, sampleCount: number): Uint8Array<ArrayBuffer> {
    if (this.fd === null) throw new Error('Audio spool is closed.');
    try {
      if (chunkCount !== this.chunks || sampleCount * 2 !== this.bytes) {
        throw new Error(
          `Capture ended at ${chunkCount} chunks/${sampleCount} samples, spool has ${this.chunks}/${this.bytes / 2}.`,
        );
      }
      // shortcut: the WAV is materialized in memory because the transcription clients take bytes; stream from the file if long recordings outgrow RAM.
      const wav = new Uint8Array(44 + this.bytes);
      writeWavHeader(new DataView(wav.buffer), this.bytes);
      let read = 0;
      while (read < this.bytes) {
        const count = readSync(this.fd, wav, 44 + read, this.bytes - read, read);
        if (count === 0) throw new Error('Audio spool is shorter than written.');
        read += count;
      }
      return wav;
    } finally {
      this.discard();
    }
  }

  /** Idempotent: closes and deletes the file. */
  discard(): void {
    if (this.fd !== null) {
      try { closeSync(this.fd); } catch { /* already closed */ }
      this.fd = null;
    }
    rmSync(this.path, { force: true });
  }
}

/** Removes spool files left by crashed app processes. Live processes keep theirs. */
export function sweepOrphanedSpools(dir = defaultSpoolDir()): void {
  let names: string[];
  try {
    ensurePrivateDir(dir);
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(/^capture-(\d+)-/.exec(name)?.[1]);
    if (!pid || pid === process.pid || isAlive(pid)) continue;
    rmSync(join(dir, name), { force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function writeWavHeader(view: DataView, dataBytes: number): void {
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SPOOL_SAMPLE_RATE, true);
  view.setUint32(28, SPOOL_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
}
