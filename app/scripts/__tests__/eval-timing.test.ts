import { expect, test } from 'bun:test';
import { correlate, parseMarks, summarize } from '../eval/timing';

test('a late mark from the previous clip is not read as the next clip\'s', () => {
  const clips = [
    { id: 'a', pressNs: '1000000000', releaseNs: '2000000000', observedNs: '2300000000' },
    { id: 'b', pressNs: '5000000000', releaseNs: '6000000000', observedNs: null },
    { id: 'c', pressNs: '8000000000', releaseNs: '9000000000', observedNs: '9500000000' },
  ];
  const marks = parseMarks([
    { event: 'pill-shown', ns: '1020000000' },
    { event: 'transcript', ns: '2200000000' },
    { event: 'paste-dispatched', ns: '2250000000', acceptedEvents: 4 },
    { event: 'clipboard-restored', ns: '5000000001' }, // clip a's restore, logged after b was pressed
    { event: 'pill-shown', ns: '5010000000' },
    { event: 'paste-dispatched', ns: '6400000000', acceptedEvents: 4 },
    { event: 'pill-shown', ns: '8010000000' },
    { event: 'transcript', ns: '9100000000' }, // b's transcript, landing after c's release
    { event: 'transcript', ns: '9200000000' },
  ].map((mark) => JSON.stringify(mark)).join('\n') + '\n');

  const [a, b, c] = correlate(clips, marks);
  expect(a).toMatchObject({
    hotkeyToPillMs: 20, releaseToTranscriptMs: 200, releaseToPasteDispatchMs: 250,
    releaseToObservedInsertMs: 300, releaseToClipboardRestoredMs: null, pasteAcceptedEvents: 4,
  });
  // b dispatched but nothing reached the box, and the stray restore stays unattributed.
  expect(b).toMatchObject({
    hotkeyToPillMs: 10, releaseToPasteDispatchMs: 400, releaseToObservedInsertMs: null,
    releaseToClipboardRestoredMs: null, releaseToTranscriptMs: null,
  });
  // b never showed text, so c's delivery marks could be b's: left out rather than guessed.
  expect(c).toMatchObject({ hotkeyToPillMs: 10, releaseToTranscriptMs: null, releaseToObservedInsertMs: 500 });
});

test('median and tail are withheld until there are enough samples', () => {
  const nine = [...Array.from({ length: 9 }, (_, i) => i), null];
  expect(summarize(nine)).toEqual({ n: 9, missing: 1, p50: null, p95: null });
  expect(summarize(Array.from({ length: 10 }, (_, i) => i))).toMatchObject({ n: 10, p50: 4.5, p95: null });
  expect(summarize(Array.from({ length: 21 }, (_, i) => i))).toMatchObject({ p50: 10, p95: 19 });
});
