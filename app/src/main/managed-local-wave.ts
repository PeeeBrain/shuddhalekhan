export function decodePcm16Wave(audio: ArrayBuffer): { samples: Float32Array; sampleRate: number } {
  if (audio.byteLength < 44) throw new Error('The recording is not a valid WAV file.');
  const bytes = new Uint8Array(audio);
  const view = new DataView(audio);
  if (text(bytes, 0, 4) !== 'RIFF' || text(bytes, 8, 12) !== 'WAVE') {
    throw new Error('The recording is not a valid WAV file.');
  }

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let format = 0;
  let dataOffset = 0;
  let dataBytes = 0;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = text(bytes, offset, offset + 4);
    const chunkBytes = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + chunkBytes > bytes.byteLength) throw new Error('The WAV file is truncated.');
    if (chunkId === 'fmt ' && chunkBytes >= 16) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (chunkId === 'data') {
      dataOffset = body;
      dataBytes = chunkBytes;
    }
    offset = body + chunkBytes + (chunkBytes % 2);
  }

  if (format !== 1 || bitsPerSample !== 16 || channels < 1 || sampleRate < 1 || dataBytes < 2) {
    throw new Error('Local speech recognition requires a PCM16 WAV recording.');
  }
  const frameBytes = channels * 2;
  if (dataBytes % frameBytes !== 0) throw new Error('The WAV audio data is truncated.');
  const samples = new Float32Array(dataBytes / frameBytes);
  for (let frame = 0; frame < samples.length; frame++) {
    let mixed = 0;
    for (let channel = 0; channel < channels; channel++) {
      mixed += view.getInt16(dataOffset + frame * frameBytes + channel * 2, true) / 32_768;
    }
    samples[frame] = mixed / channels;
  }
  return { samples, sampleRate };
}

function text(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}
