import { expect, it } from 'bun:test';
import type { PerformanceMarker } from '../../src/main/performance/marker-collector';
import { summarizeMicrophoneStartup } from '../microphone-startup-benchmark';

const marker = (
  event: string,
  ms: number,
  recordingSessionId: string,
  surface = 'dictation',
): PerformanceMarker => ({
  schemaVersion: 1,
  runId: 'trial',
  scenarioId: 'microphone-startup',
  sequence: ms,
  event,
  mainMonotonicMs: ms,
  utc: '2026-09-26T00:00:00.000Z',
  pid: 1,
  processRole: 'electron-main',
  recordingSessionId,
  surface,
});

it('correlates real microphone startup events and counts missing callbacks', () => {
  const summary = summarizeMicrophoneStartup([
    marker('hotkey.detected', 100, 'a'),
    marker('audio.capture.started', 260, 'a'),
    marker('audio.first-buffer.received', 490, 'a'),
    marker('hotkey.detected', 600, 'b'),
    marker('audio.capture.started', 800, 'b'),
    marker('audio.first-buffer.received', 1030, 'b'),
    marker('hotkey.detected', 1100, 'c'),
    marker('audio.capture.started', 1200, 'other', 'agent'),
  ]);

  expect(summary.attempts).toBe(3);
  expect(summary.hotkeyToGraphMs).toMatchObject({ count: 2, failures: 1, p50: 180 });
  expect(summary.hotkeyToFirstBufferCallbackMs).toMatchObject({ count: 2, failures: 1, p50: 410 });
  expect(summary.trials[2]).toEqual({ graphMs: null, firstBufferCallbackMs: null });
});

it('shows whether microphone acquisition or audio graph setup dominates startup', () => {
  const capture = marker('audio.capture.started', 310, 'a');
  capture.micAcquisitionMs = 180;
  capture.graphSetupMs = 20;

  const summary = summarizeMicrophoneStartup([
    marker('hotkey.detected', 100, 'a'),
    capture,
  ]);

  expect(summary.micAcquisitionMs.p50).toBe(180);
  expect(summary.graphSetupMs.p50).toBe(20);
});

it('reports the cold Managed Local model load across app launches', () => {
  const summary = summarizeMicrophoneStartup([
    Object.assign(marker('managed-local.model.loaded', 100, ''), { loadMilliseconds: 9_469 }),
    Object.assign(marker('managed-local.model.loaded', 200, ''), { loadMilliseconds: 8_794 }),
    Object.assign(marker('managed-local.model.loaded', 300, ''), { loadMilliseconds: 9_772 }),
  ]);

  expect(summary.managedLocalModelLoadMs).toMatchObject({ count: 3, p50: 9_469 });
});
