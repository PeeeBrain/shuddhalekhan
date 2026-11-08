import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioSpool, sweepOrphanedSpools } from '../audio-spool';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'spool-test-'));
  dirs.push(dir);
  return dir;
};
const pcm = (...samples: number[]) => new Uint8Array(Int16Array.from(samples).buffer);

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('AudioSpool', () => {
  it('materializes exactly the spooled samples as a 16 kHz mono WAV and deletes the file', () => {
    const spool = AudioSpool.open(tempDir());
    spool.append(0, pcm(1, -2));
    spool.append(1, pcm(32767));

    const wav = spool.finish(2, 3);
    const view = new DataView(wav.buffer);

    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(6);
    expect(Array.from(new Int16Array(wav.buffer.slice(44)))).toEqual([1, -2, 32767]);
    expect(existsSync(spool.path)).toBe(false);
  });

  it('rejects an out-of-order chunk instead of spooling past a gap', () => {
    const spool = AudioSpool.open(tempDir());
    spool.append(0, pcm(1));
    expect(() => spool.append(2, pcm(2))).toThrow('expected 1');
    spool.discard();
    expect(existsSync(spool.path)).toBe(false);
  });

  it('fails a declared end boundary that the spool does not hold, and still deletes the file', () => {
    const spool = AudioSpool.open(tempDir());
    spool.append(0, pcm(1, 2));
    // The final chunk never arrived.
    expect(() => spool.finish(2, 4)).toThrow('Capture ended at 2 chunks/4 samples');
    expect(existsSync(spool.path)).toBe(false);
  });

  it('fails a disk-full or no-progress write instead of looping, and still discards the file', () => {
    const spool = AudioSpool.open(tempDir());
    const write = spyOn(fs, 'writeSync');
    try {
      write.mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      });
      expect(() => spool.append(0, pcm(1))).toThrow('ENOSPC');
      write.mockImplementationOnce(() => 0);
      expect(() => spool.append(0, pcm(1))).toThrow('no progress');
    } finally {
      write.mockRestore();
    }
    spool.discard();
    expect(existsSync(spool.path)).toBe(false);
  });

  it('rejects audio past the largest size a WAV header can describe instead of wrapping', () => {
    const spool = AudioSpool.open(tempDir());
    // Reaching 4 GiB for real is too slow for a unit test; jump the byte count.
    (spool as unknown as { bytes: number }).bytes = 0xffff_ffff - 37;
    expect(() => spool.append(0, pcm(1))).toThrow('longer than a WAV file can hold');
    spool.discard();
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked or group/other-accessible spool directory', () => {
    const root = tempDir();
    const target = join(root, 'elsewhere');
    mkdirSync(target, { mode: 0o700 });
    const link = join(root, 'link');
    symlinkSync(target, link);
    expect(() => AudioSpool.open(link)).toThrow('unsafe audio spool directory');

    const shared = join(root, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o755);
    expect(() => AudioSpool.open(shared)).toThrow('unsafe audio spool directory');
    expect(readdirSync(target)).toEqual([]);
    expect(readdirSync(shared)).toEqual([]);
  });

  it('sweeps spools of dead processes but keeps this process\'s files', () => {
    const dir = tempDir();
    const own = AudioSpool.open(dir);
    writeFileSync(join(dir, 'capture-2147483646-orphan.pcm'), 'x');

    sweepOrphanedSpools(dir);

    expect(readdirSync(dir)).toEqual([own.path.slice(dir.length + 1)]);
    own.discard();
  });
});
