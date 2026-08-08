/**
 * PROTOTYPE — throw away after issue 157 is resolved.
 *
 * Question: Can direct UTF-16 KEYEVENTF_UNICODE insertion be the low-latency
 * path across Shuddhalekhan's target matrix, and does certainty-based recovery
 * remain safe when SendInput accepts none, all, or only part of an event batch?
 */
import { emitKeypressEvents } from 'node:readline';
import { dispatchUnicode } from './win32-unicode';
import {
  initialState,
  interpretDispatch,
  reducePrototype,
  type Observation,
  type PrototypeState,
  type SampleCase,
  type TargetCase,
} from './state';

const bold = '\x1b[1m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';

const targets: TargetCase[] = [
  { id: 'notepad', label: 'Notepad', dispatchAllowed: true },
  { id: 'office', label: 'Word / Office editor', dispatchAllowed: true },
  { id: 'browser', label: 'Browser contenteditable / textarea', dispatchAllowed: true },
  { id: 'vscode', label: 'VS Code editor', dispatchAllowed: true },
  { id: 'terminal', label: 'Windows Terminal / console (no newline)', dispatchAllowed: true },
  { id: 'ime', label: 'Editor with an IME active', dispatchAllowed: true },
  { id: 'rdp', label: 'Remote Desktop target', dispatchAllowed: true },
  { id: 'elevated', label: 'Elevated target from non-elevated harness', dispatchAllowed: true },
  { id: 'sensitive', label: 'Password / sensitive field', dispatchAllowed: false },
];

const samples: SampleCase[] = [
  { id: 'latin', label: 'Latin delta', text: 'Shuddha ' },
  { id: 'indic', label: 'Devanagari / Indic', text: 'शुद्धलेखन ' },
  { id: 'emoji', label: 'Emoji + surrogate/ZWJ', text: '🙂 👨‍👩‍👧‍👦 ' },
  { id: 'combining', label: 'Combining marks', text: 'Cafe\u0301 नमस्ते ' },
];

let state: PrototypeState = initialState;
let busy = false;

function currentTarget(): TargetCase {
  return targets[state.targetIndex];
}

function currentSample(): SampleCase {
  return samples[state.sampleIndex];
}

function render(): void {
  console.clear();
  const target = currentTarget();
  const sample = currentSample();
  const currentRow = state.rows.find(
    (row) => row.targetId === target.id && row.sampleId === sample.id
  );
  const completed = state.rows.filter((row) => row.observation !== 'pending').length;
  console.log(`${bold}PROTOTYPE — incremental Unicode insertion${reset}`);
  console.log(`${dim}No state is persisted. No Enter/newline is ever sent.${reset}\n`);
  console.log(`${bold}target${reset}: ${target.label}`);
  console.log(`${bold}sample${reset}: ${sample.label} = ${JSON.stringify(sample.text)}`);
  console.log(`${bold}dispatch allowed${reset}: ${target.dispatchAllowed}`);
  console.log(`${bold}automatic insertion halted${reset}: ${state.halted}`);
  console.log(`${bold}current observation${reset}: ${currentRow?.observation ?? 'not run'}`);
  console.log(`${bold}completed cells${reset}: ${completed}/${targets.length * samples.length}`);
  console.log(`${bold}last note${reset}: ${state.note}\n`);
  console.log(`${bold}[t]${reset} ${dim}next target${reset}  ${bold}[s]${reset} ${dim}next sample${reset}`);
  console.log(`${bold}[d]${reset} ${dim}dispatch after 3s (focus target)${reset}`);
  console.log(`${bold}[y]${reset} ${dim}correct${reset}  ${bold}[w]${reset} ${dim}wrong/missing${reset}  ${bold}[b]${reset} ${dim}blocked${reset}  ${bold}[i]${reset} ${dim}IME interference${reset}`);
  console.log(`${bold}[a]${reset} ${dim}simulate ambiguous partial dispatch${reset}  ${bold}[r]${reset} ${dim}reset halt${reset}  ${bold}[q]${reset} ${dim}quit + print matrix${reset}`);
}

function observe(observation: Exclude<Observation, 'pending'>): void {
  state = reducePrototype(state, {
    type: 'observe',
    targetId: currentTarget().id,
    sampleId: currentSample().id,
    observation,
  });
}

function printMatrixAndExit(): never {
  console.clear();
  console.log('| Target | Sample | Observation | SendInput evidence |');
  console.log('|---|---|---|---|');
  for (const target of targets) {
    for (const sample of samples) {
      const row = state.rows.find(
        (candidate) => candidate.targetId === target.id && candidate.sampleId === sample.id
      );
      const evidence = row?.evidence
        ? `${row.evidence.acceptedEvents}/${row.evidence.expectedEvents}; ${row.evidence.certainty}`
        : 'not dispatched';
      console.log(`| ${target.label} | ${sample.label} | ${row?.observation ?? 'not run'} | ${evidence} |`);
    }
  }
  process.stdin.setRawMode(false);
  process.exit(0);
}

async function runDispatch(): Promise<void> {
  if (state.halted) {
    state = { ...state, note: 'Refused: ambiguous partial dispatch requires an explicit reset.' };
    return;
  }
  if (!currentTarget().dispatchAllowed) {
    state = { ...state, note: 'Refused: current seam cannot reliably detect sensitive fields.' };
    return;
  }
  busy = true;
  console.clear();
  console.log(`${bold}Focus ${currentTarget().label} now.${reset}`);
  console.log(`Dispatching ${JSON.stringify(currentSample().text)} in 3 seconds…`);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const target = currentTarget();
  const sample = currentSample();
  const result = dispatchUnicode(sample.text);
  state = reducePrototype(state, {
    type: 'dispatch',
    targetId: target.id,
    sampleId: sample.id,
    evidence: result.evidence,
  });
  state = {
    ...state,
    note: `${state.note}; hwnd=${result.target?.hwnd ?? 'unknown'}; exe=${result.target?.executablePath ?? 'unknown'}`,
  };
  busy = false;
}

emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('keypress', async (value) => {
  if (busy) return;
  switch (value.toLowerCase()) {
    case 't':
      state = reducePrototype(state, { type: 'next-target', targetCount: targets.length });
      break;
    case 's':
      state = reducePrototype(state, { type: 'next-sample', sampleCount: samples.length });
      break;
    case 'd':
      await runDispatch();
      break;
    case 'y': observe('correct'); break;
    case 'w': observe('wrong'); break;
    case 'b': observe('blocked'); break;
    case 'i': observe('ime-interference'); break;
    case 'a': {
      state = reducePrototype(state, {
        type: 'simulate-partial',
        evidence: interpretDispatch(3, 8, 5),
      });
      break;
    }
    case 'r': state = reducePrototype(state, { type: 'reset-halt' }); break;
    case 'q': printMatrixAndExit();
  }
  render();
});

render();
