import { readFileSync } from 'node:fs';
import type { PerformanceMarker } from '../src/main/performance/marker-collector';
import { parseMarkerStream, summarizeLatency } from './performance/summarize-markers';

export function summarizeMicrophoneStartup(markers: PerformanceMarker[]) {
  const sessions = new Map<string, {
    hotkey?: number;
    graph?: number;
    firstBuffer?: number;
    micAcquisitionMs?: number;
    graphSetupMs?: number;
  }>();
  for (const marker of markers) {
    if (marker.surface !== 'dictation' || !marker.recordingSessionId) continue;
    const key = `${marker.runId}:${marker.recordingSessionId}`;
    const session = sessions.get(key) ?? {};
    if (marker.event === 'hotkey.detected') session.hotkey = marker.mainMonotonicMs;
    if (marker.event === 'audio.capture.started') {
      session.graph = marker.mainMonotonicMs;
      if (typeof marker.micAcquisitionMs === 'number') session.micAcquisitionMs = marker.micAcquisitionMs;
      if (typeof marker.graphSetupMs === 'number') session.graphSetupMs = marker.graphSetupMs;
    }
    if (marker.event === 'audio.first-buffer.received') session.firstBuffer = marker.mainMonotonicMs;
    sessions.set(key, session);
  }

  const trials = [...sessions.values()].filter((session) => session.hotkey !== undefined);
  const graph = trials.flatMap((session) =>
    session.graph !== undefined && session.hotkey !== undefined
      ? [session.graph - session.hotkey] : []);
  const firstBuffer = trials.flatMap((session) =>
    session.firstBuffer !== undefined && session.hotkey !== undefined
      ? [session.firstBuffer - session.hotkey] : []);
  const modelLoads = markers.filter((marker) => marker.event === 'managed-local.model.loaded');

  return {
    attempts: trials.length,
    managedLocalModelLoadMs: summarizeLatency(modelLoads.flatMap((marker) =>
      'loadMilliseconds' in marker && typeof marker.loadMilliseconds === 'number'
        && Number.isFinite(marker.loadMilliseconds) ? [marker.loadMilliseconds] : []), modelLoads.length),
    hotkeyToGraphMs: summarizeLatency(graph, trials.length),
    hotkeyToFirstBufferCallbackMs: summarizeLatency(firstBuffer, trials.length),
    micAcquisitionMs: summarizeLatency(trials.flatMap((session) =>
      session.micAcquisitionMs === undefined ? [] : [session.micAcquisitionMs]), trials.length),
    graphSetupMs: summarizeLatency(trials.flatMap((session) =>
      session.graphSetupMs === undefined ? [] : [session.graphSetupMs]), trials.length),
    trials: trials.map((session) => ({
      graphMs: session.graph !== undefined && session.hotkey !== undefined
        ? Math.round(session.graph - session.hotkey) : null,
      firstBufferCallbackMs: session.firstBuffer !== undefined && session.hotkey !== undefined
        ? Math.round(session.firstBuffer - session.hotkey) : null,
    })),
  };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage from repo root: bun app/scripts/microphone-startup-benchmark.ts <events.jsonl>');
    process.exitCode = 1;
  } else {
    const summary = summarizeMicrophoneStartup(parseMarkerStream(readFileSync(path, 'utf8')));
    console.log(JSON.stringify(summary, null, 2));
    if (summary.attempts === 0 && summary.managedLocalModelLoadMs.count === 0) process.exitCode = 1;
  }
}
