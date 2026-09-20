import { describe, expect, it } from 'bun:test';
import { decodePcm16Wave } from '../managed-local-wave';

describe('managed local WAV boundary', () => {
  it('decodes PCM16 mono samples for the native recognizer', () => {
    const wav = new Uint8Array(48);
    const view = new DataView(wav.buffer);
    wav.set(new TextEncoder().encode('RIFF'), 0);
    view.setUint32(4, 40, true);
    wav.set(new TextEncoder().encode('WAVEfmt '), 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16_000, true);
    view.setUint16(34, 16, true);
    wav.set(new TextEncoder().encode('data'), 36);
    view.setUint32(40, 4, true);
    view.setInt16(44, -32_768, true);
    view.setInt16(46, 16_384, true);

    const decoded = decodePcm16Wave(wav.buffer);

    expect(decoded.sampleRate).toBe(16_000);
    expect(Array.from(decoded.samples)).toEqual([-1, 0.5]);
  });

  it('rejects unsupported or truncated audio', () => {
    expect(() => decodePcm16Wave(new ArrayBuffer(8))).toThrow('WAV');
  });
});
