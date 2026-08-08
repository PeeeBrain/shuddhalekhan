/* global document, navigator, window, crypto, performance, AudioContext, AudioWorkletNode, URL, Blob, setTimeout */
// PROTOTYPE ONLY — intentionally dependency-free and isolated from production.
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 320;

const elements = Object.fromEntries(
  ['device', 'trials', 'idleMs', 'captureMs', 'sinkDelayMs', 'queueCapacity', 'hiddenMs', 'prepare', 'strict', 'hidden', 'retained', 'stopRetained', 'guided', 'long', 'diagnostics', 'deviceSwitch', 'export', 'status', 'progress', 'results', 'medianLatency', 'privacyResult', 'integrityResult', 'interpretation', 'diagnosticSummary', 'feltInstant', 'feltDelayed', 'output']
    .map((id) => [id, document.getElementById(id)])
);

const report = {
  question: 'Can strict idle microphone privacy preserve acceptable first-PCM latency with a warm renderer/worklet?',
  createdAt: new Date().toISOString(),
  platform: navigator.userAgent,
  deviceEvents: [],
  trials: [],
};

let context;
let workletUrl;
let retainedStream;

const workletSource = `
class FixedPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.phase = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || channels[0].length === 0) return true;
    const frames = channels[0].length;
    const ratio = sampleRate / ${TARGET_SAMPLE_RATE};
    while (this.phase < frames) {
      const index = Math.min(frames - 1, Math.floor(this.phase));
      let mono = 0;
      for (let channel = 0; channel < channels.length; channel += 1) mono += channels[channel][index] || 0;
      this.pending.push(mono / channels.length);
      this.phase += ratio;
    }
    this.phase -= frames;
    while (this.pending.length >= ${CHUNK_SAMPLES}) {
      const pcm = new Int16Array(${CHUNK_SAMPLES});
      let absolute = 0;
      for (let i = 0; i < pcm.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, this.pending[i]));
        absolute += Math.abs(sample);
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      this.pending.splice(0, ${CHUNK_SAMPLES});
      this.port.postMessage({ type: 'pcm', bytes: pcm.buffer, level: absolute / pcm.length }, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('fixed-pcm-processor', FixedPcmProcessor);
`;

function value(id) { return Number(elements[id].value); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function setStatus(text) { elements.status.textContent = text; }
function render() { elements.output.textContent = JSON.stringify(report, null, 2); }

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function renderGuidedSummary() {
  const trials = report.trials.filter((trial) => trial.phase === 'guided');
  if (trials.length === 0) return;
  const typical = median(trials.map((trial) => trial.startToFirstPcmMs));
  const stopped = trials.every((trial) => trial.microphoneTrackStopped);
  const equivalent = trials.every((trial) => trial.batchEquivalent);
  elements.medianLatency.textContent = `${typical.toFixed(0)} ms`;
  elements.privacyResult.textContent = stopped ? '5/5 stopped' : 'Check failed';
  elements.integrityResult.textContent = equivalent ? '5/5 matched' : 'Chunks lost';
  elements.interpretation.textContent = `The microphone took a median of ${typical.toFixed(0)} ms from activation to the first 20 ms PCM chunk. No pass/fail budget has been invented: your perception below and the later baseline protocol decide whether this is acceptable.`;
  elements.results.style.display = 'block';
}

function setBusy(next) {
  for (const id of ['prepare', 'strict', 'hidden', 'retained', 'guided', 'long', 'diagnostics', 'deviceSwitch']) elements[id].disabled = next;
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function concatenate(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return result;
}

function encodeWavFromPcm16(pcmBytes) {
  const wav = new Uint8Array(44 + pcmBytes.byteLength);
  const view = new DataView(wav.buffer);
  const write = (offset, text) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes.byteLength, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, pcmBytes.byteLength, true);
  wav.set(pcmBytes, 44);
  return wav;
}

async function ensureContext() {
  if (!context) {
    context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'interactive' });
    workletUrl = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
    await context.audioWorklet.addModule(workletUrl);
  }
  if (context.state !== 'running') await context.resume();
  return context;
}

async function refreshDevices() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
  const selected = elements.device.value;
  elements.device.replaceChildren(...devices.map((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Microphone ${index + 1}`;
    return option;
  }));
  if (devices.some((device) => device.deviceId === selected)) elements.device.value = selected;
  report.deviceInventory = devices.map((device) => ({ deviceId: device.deviceId, label: device.label }));
}

function constraints() {
  return {
    audio: {
      deviceId: elements.device.value ? { exact: elements.device.value } : undefined,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  };
}

async function prepare({ manageBusy = true } = {}) {
  if (manageBusy) setBusy(true);
  try {
    setStatus('Requesting permission; this track will be stopped immediately…');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    await ensureContext();
    await refreshDevices();
    setStatus(`Prepared. AudioContext=${context.sampleRate} Hz; no microphone track retained.`);
  } finally {
    if (manageBusy) setBusy(false);
  }
}

async function acquire(policy) {
  if (policy === 'retained' && retainedStream?.active) return retainedStream;
  const stream = await navigator.mediaDevices.getUserMedia(constraints());
  if (policy === 'retained') retainedStream = stream;
  return stream;
}

async function runTrial({ policy, hidden = false, phase = 'custom' }) {
  await ensureContext();
  if (hidden) await window.audioPrototype.hideFor(value('hiddenMs'));

  const runId = crypto.randomUUID();
  const metricsBefore = await window.audioPrototype.metrics();
  await window.audioPrototype.sinkStart(runId);
  const startedAt = performance.now();
  let stream;
  try {
  stream = await acquire(policy);
  const acquiredAt = performance.now();
  const track = stream.getAudioTracks()[0];
  const trackSettings = track.getSettings();
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'fixed-pcm-processor', { numberOfInputs: 1, numberOfOutputs: 0 });
  const chunks = [];
  const queue = [];
  let sending = false;
  let droppedChunks = 0;
  let firstPcmAt;
  let firstPcmResolve;
  const firstPcm = new Promise((resolve) => { firstPcmResolve = resolve; });

  async function drain() {
    if (sending) return;
    sending = true;
    while (queue.length > 0) {
      const bytes = queue.shift();
      await window.audioPrototype.sendChunk(runId, bytes, value('sinkDelayMs'));
    }
    sending = false;
  }

  node.port.onmessage = (event) => {
    if (event.data.type !== 'pcm') return;
    const bytes = event.data.bytes;
    chunks.push(bytes.slice(0));
    if (firstPcmAt === undefined) {
      firstPcmAt = performance.now();
      firstPcmResolve();
    }
    if (queue.length >= value('queueCapacity')) {
      droppedChunks += 1;
    } else {
      queue.push(bytes);
      void drain();
    }
  };

  source.connect(node);
  await Promise.race([firstPcm, sleep(3000).then(() => { throw new Error('No PCM arrived within 3 seconds'); })]);
  await sleep(value('captureMs'));
  source.disconnect();
  node.disconnect();
  if (policy === 'strict') stream.getTracks().forEach((item) => item.stop());
  while (sending || queue.length > 0) await sleep(10);

  const batchBytes = concatenate(chunks);
  const batchWav = encodeWavFromPcm16(batchBytes);
  const sink = await window.audioPrototype.sinkFinish(runId);
  const batchHash = await sha256(batchBytes);
  const wavPayloadHash = await sha256(batchWav.slice(44));
  const metricsAfter = await window.audioPrototype.metrics();
  const result = {
    runId,
    policy,
    hidden,
    phase,
    startedAtIso: new Date().toISOString(),
    contextSampleRate: context.sampleRate,
    trackSettings: {
      deviceId: trackSettings.deviceId,
      sampleRate: trackSettings.sampleRate,
      channelCount: trackSettings.channelCount,
      latency: trackSettings.latency,
    },
    deviceOpenMs: Number((acquiredAt - startedAt).toFixed(2)),
    startToFirstPcmMs: Number((firstPcmAt - startedAt).toFixed(2)),
    acquiredToFirstPcmMs: Number((firstPcmAt - acquiredAt).toFixed(2)),
    producedChunks: chunks.length,
    deliveredChunks: sink.chunks,
    droppedChunks,
    batchBytes: batchBytes.byteLength,
    deliveredBytes: sink.bytes,
    batchHash,
    deliveredHash: sink.hash,
    batchEquivalent: batchHash === sink.hash && batchBytes.byteLength === sink.bytes,
    batchWavBytes: batchWav.byteLength,
    wavPayloadEquivalent: wavPayloadHash === batchHash,
    microphoneTrackStopped: policy === 'strict' ? track.readyState === 'ended' : false,
    metricsBefore,
    metricsAfter,
  };
  report.trials.push(result);
  render();
  return result;
  } catch (error) {
    if (policy === 'strict') stream?.getTracks().forEach((track) => track.stop());
    await window.audioPrototype.sinkFinish(runId).catch(() => undefined);
    throw error;
  }
}

async function runSequence(policy, phase = 'custom') {
  setBusy(true);
  try {
    for (let index = 0; index < value('trials'); index += 1) {
      setStatus(`Opening and closing the microphone: check ${index + 1} of ${value('trials')}…`);
      if (phase === 'guided') {
        elements.progress.style.display = 'block';
        elements.progress.max = value('trials');
        elements.progress.value = index;
      }
      await runTrial({ policy, phase });
      if (phase === 'guided') elements.progress.value = index + 1;
      if (index + 1 < value('trials')) await sleep(value('idleMs'));
    }
    setStatus('Test complete. Your microphone is off.');
    if (phase === 'guided') renderGuidedSummary();
  } finally {
    if (policy === 'retained') {
      retainedStream?.getTracks().forEach((track) => track.stop());
      retainedStream = undefined;
    }
    setBusy(false);
  }
}

elements.prepare.addEventListener('click', () => prepare().catch((error) => setStatus(error.stack || String(error))));
elements.strict.addEventListener('click', () => runSequence('strict').catch((error) => { setStatus(error.stack || String(error)); setBusy(false); }));
elements.guided.addEventListener('click', async () => {
  setBusy(true);
  try {
    report.trials = report.trials.filter((trial) => trial.phase !== 'guided');
    elements.results.style.display = 'none';
    elements.trials.value = '5';
    elements.idleMs.value = '1000';
    elements.captureMs.value = '1200';
    elements.sinkDelayMs.value = '0';
    elements.queueCapacity.value = '25';
    await prepare({ manageBusy: false });
    await runSequence('strict', 'guided');
  } catch (error) {
    setStatus(error.stack || String(error));
    setBusy(false);
  }
});
elements.long.addEventListener('click', async () => {
  setBusy(true);
  try {
    if (!context) await prepare({ manageBusy: false });
    for (let seconds = 60; seconds > 0; seconds -= 1) {
      setStatus(`Microphone is off. Long-idle check starts in ${seconds} seconds…`);
      await sleep(1000);
    }
    setStatus('Reopening the microphone after 60 seconds idle…');
    const result = await runTrial({ policy: 'strict', phase: 'long-idle' });
    setStatus(`Long-idle result: ${result.startToFirstPcmMs.toFixed(0)} ms. The microphone is off again.`);
  } catch (error) {
    setStatus(error.stack || String(error));
  } finally {
    setBusy(false);
  }
});
elements.diagnostics.addEventListener('click', async () => {
  setBusy(true);
  const original = {
    captureMs: elements.captureMs.value,
    sinkDelayMs: elements.sinkDelayMs.value,
    queueCapacity: elements.queueCapacity.value,
    hiddenMs: elements.hiddenMs.value,
  };
  try {
    if (!context) await prepare({ manageBusy: false });
    elements.captureMs.value = '1200';
    elements.queueCapacity.value = '25';
    elements.hiddenMs.value = '2500';
    elements.sinkDelayMs.value = '0';
    setStatus('Check 1 of 5: recording while the window is hidden. It will return automatically…');
    const hiddenResult = await runTrial({ policy: 'strict', hidden: true, phase: 'diagnostic-hidden' });

    const backpressure = [];
    for (const delayMs of [0, 10, 30, 50]) {
      elements.sinkDelayMs.value = String(delayMs);
      setStatus(`Backpressure check ${backpressure.length + 2} of 5: ${delayMs} ms consumer delay…`);
      backpressure.push(await runTrial({ policy: 'strict', phase: `diagnostic-backpressure-${delayMs}ms` }));
    }
    const firstDrop = backpressure.find((trial) => trial.droppedChunks > 0);
    const allWavEquivalent = [hiddenResult, ...backpressure].every((trial) => trial.wavPayloadEquivalent);
    elements.diagnosticSummary.textContent = `Hidden-window capture ${hiddenResult.droppedChunks === 0 ? 'kept up without drops' : `dropped ${hiddenResult.droppedChunks} chunks`}. The bounded queue first overflowed ${firstDrop ? `at ${firstDrop.phase.replace('diagnostic-backpressure-', '')}` : 'at none of the tested delays'}. Batch WAV payloads ${allWavEquivalent ? 'matched the realtime PCM source' : 'did not match'}.`;
    setStatus('Automatic diagnostics complete. Your microphone is off. Export the results again.');
  } catch (error) {
    setStatus(error.stack || String(error));
  } finally {
    elements.captureMs.value = original.captureMs;
    elements.sinkDelayMs.value = original.sinkDelayMs;
    elements.queueCapacity.value = original.queueCapacity;
    elements.hiddenMs.value = original.hiddenMs;
    setBusy(false);
    render();
  }
});
elements.deviceSwitch.addEventListener('click', async () => {
  setBusy(true);
  const originalCaptureMs = elements.captureMs.value;
  try {
    if (!context) await prepare({ manageBusy: false });
    await refreshDevices();
    const devices = report.deviceInventory ?? [];
    if (devices.length < 2) {
      setStatus('Only one browser-visible microphone is available, so a device switch cannot be tested here.');
      return;
    }
    elements.captureMs.value = '800';
    const originalDeviceId = elements.device.value || devices[0].deviceId;
    const alternative = devices.find((device) => device.deviceId !== originalDeviceId);
    if (!alternative) throw new Error('No alternative microphone was found');

    elements.device.value = alternative.deviceId;
    setStatus(`Opening “${alternative.label || 'the second microphone'}”, then closing it completely…`);
    const alternativeResult = await runTrial({ policy: 'strict', phase: 'device-switch-alternative' });

    elements.device.value = originalDeviceId;
    const original = devices.find((device) => device.deviceId === originalDeviceId);
    setStatus(`Switching back to “${original?.label || 'the original microphone'}”, then closing it completely…`);
    const returnResult = await runTrial({ policy: 'strict', phase: 'device-switch-return' });

    report.deviceSwitch = {
      alternativeLabel: alternative.label,
      returnLabel: original?.label ?? 'original microphone',
      alternativeTrackStopped: alternativeResult.microphoneTrackStopped,
      returnTrackStopped: returnResult.microphoneTrackStopped,
      alternativeStartToFirstPcmMs: alternativeResult.startToFirstPcmMs,
      returnStartToFirstPcmMs: returnResult.startToFirstPcmMs,
    };
    setStatus(`Device switch complete: ${alternativeResult.startToFirstPcmMs.toFixed(0)} ms to the alternate mic, ${returnResult.startToFirstPcmMs.toFixed(0)} ms switching back. Both tracks are off.`);
  } catch (error) {
    setStatus(error.stack || String(error));
  } finally {
    elements.captureMs.value = originalCaptureMs;
    setBusy(false);
    render();
  }
});
elements.hidden.addEventListener('click', async () => {
  setBusy(true);
  try {
    setStatus('Running while the window is hidden…');
    await runTrial({ policy: 'strict', hidden: true });
    setStatus('Hidden strict trial complete.');
  } catch (error) {
    setStatus(error.stack || String(error));
  } finally {
    setBusy(false);
  }
});
elements.retained.addEventListener('click', () => runSequence('retained').catch((error) => { setStatus(error.stack || String(error)); setBusy(false); }));
elements.stopRetained.addEventListener('click', () => {
  retainedStream?.getTracks().forEach((track) => track.stop());
  retainedStream = undefined;
  setStatus('Retained comparator track stopped.');
});
elements.export.addEventListener('click', async () => {
  const file = await window.audioPrototype.saveReport(report);
  setStatus(file ? `Report saved to ${file}` : 'Export cancelled.');
});
elements.feltInstant.addEventListener('click', () => {
  report.subjective = { activationFeltImmediate: true, recordedAt: new Date().toISOString() };
  setStatus('Recorded: activation felt immediate.');
  render();
});
elements.feltDelayed.addEventListener('click', () => {
  report.subjective = { activationFeltImmediate: false, recordedAt: new Date().toISOString() };
  setStatus('Recorded: you noticed activation delay.');
  render();
});

navigator.mediaDevices.addEventListener('devicechange', async () => {
  report.deviceEvents.push({ at: new Date().toISOString(), type: 'devicechange' });
  await refreshDevices();
  render();
});

window.addEventListener('beforeunload', () => {
  retainedStream?.getTracks().forEach((track) => track.stop());
  if (workletUrl) URL.revokeObjectURL(workletUrl);
});

render();
