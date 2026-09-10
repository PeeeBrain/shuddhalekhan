import { parseArgs } from 'util';
import { captureForegroundTarget } from '../../src/main/native/target';
import { validateExactTarget } from '../../src/shared/live-dictation';
import { sendUnicodeText } from '../../src/main/native/unicode-input';

/**
 * Packaged smoke dispatcher: drives the exact production Live Dictation
 * insertion seam (captureForegroundTarget -> validateExactTarget ->
 * sendUnicodeText) against whatever window the operator focused beforehand.
 * Emits one JSON line on stdout so the PowerShell orchestrator can verify
 * the captured target and SendInput acceptance classification.
 */

const { values } = parseArgs({
  options: {
    textB64: { type: 'string' },
    'settle-ms': { type: 'string', default: '1200' },
    'expect-exe': { type: 'string', default: '' },
    'expect-pid': { type: 'string', default: '' },
    'expect-hwnd': { type: 'string', default: '' },
  },
});

if (!values.textB64) {
  console.error('--text-b64 is required');
  process.exit(2);
}

const text = Buffer.from(values.textB64, 'base64').toString('utf8');
const settleMs = Number(values['settle-ms'] ?? '1200');
const expectExe = (values['expect-exe'] ?? '').toLowerCase();
const expectPid = values['expect-pid'] ? Number(values['expect-pid']) : null;
const expectHwnd = values['expect-hwnd'] ? Number(values['expect-hwnd']) : null;

function captureMatchingTarget(): ReturnType<typeof captureForegroundTarget> {
  const snapshot = captureForegroundTarget();
  if (!snapshot) return null;
  if (
    expectExe
    && snapshot.executablePath
    && !snapshot.executablePath.toLowerCase().includes(expectExe)
  ) {
    return null;
  }
  if (expectPid !== null && snapshot.processId !== expectPid) {
    return null;
  }
  if (expectHwnd !== null && snapshot.hwnd !== expectHwnd) {
    return null;
  }
  return snapshot;
}

// Give the orchestrator time to focus the target edit surface, then wait for
// the expected application to actually own the foreground before dispatching.
await new Promise((resolve) => setTimeout(resolve, settleMs));

let original: ReturnType<typeof captureForegroundTarget> = null;
const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  original = captureMatchingTarget();
  if (original) break;
  await new Promise((resolve) => setTimeout(resolve, 300));
}
if (!original) {
  console.log(JSON.stringify({ ok: false, stage: 'capture', reason: `foreground never matched ${expectPid !== null ? `pid ${expectPid}` : expectExe}` }));
  process.exit(0);
}

// Mirror the controller's synchronous revalidation right before dispatch.
const validation = validateExactTarget(original, captureForegroundTarget());
if (!validation.allowed) {
  console.log(JSON.stringify({ ok: false, stage: 'validate', reason: validation.reason }));
  process.exit(0);
}

const result = sendUnicodeText(text);

console.log(JSON.stringify({
  ok: true,
  stage: 'dispatched',
  target: {
    hwnd: original.hwnd.toString(),
    processId: original.processId,
    executablePath: original.executablePath,
    processCreationTime: original.processCreationTime,
    windowClass: original.windowClass,
  },
  acceptedEvents: result.acceptedEvents,
  expectedEvents: result.expectedEvents,
  certainty: result.certainty,
  recovery: result.recovery,
}));
