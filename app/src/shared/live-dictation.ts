import type { DictationTargetSnapshot } from '../types/ipc';

export const LIVE_UNICODE_DISPATCH_CODE_UNIT_LIMIT = 4096;
export const LIVE_KEYBOARD_RELEASE_GRACE_MS = 1000;

export type UnicodeDispatchCertainty =
  | 'none-accepted'
  | 'os-accepted-all'
  | 'ambiguous-partial';

export type UnicodeDispatchRecovery =
  | 'retry-safe'
  | 'copy-only'
  | 'halt';

export interface UnicodeDispatchInterpretation {
  certainty: UnicodeDispatchCertainty;
  recovery: UnicodeDispatchRecovery;
  advanceCursor: boolean;
}

export interface ProjectCommittedTextOptions {
  finalizing?: boolean;
}

function isProjectableWhitespace(code: number): boolean {
  if (code === 0x20 || code === 0xa0 || code === 0x3000) return true;
  return code >= 0x2000 && code <= 0x200a;
}

function stripLeadingProjectableWhitespace(text: string): string {
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (!isProjectableWhitespace(code)) break;
    index += 1;
  }
  return text.slice(index);
}

function stripTrailingProjectableWhitespace(text: string): string {
  let index = text.length;
  while (index > 0) {
    const code = text.charCodeAt(index - 1);
    if (!isProjectableWhitespace(code)) break;
    index -= 1;
  }
  return text.slice(0, index);
}

export function projectCommittedText(
  rawCommitted: string,
  dispatchedProjectedLength: number,
  options: ProjectCommittedTextOptions = {},
): string {
  let text = rawCommitted;
  if (dispatchedProjectedLength === 0) {
    text = stripLeadingProjectableWhitespace(text);
  }
  if (!options.finalizing) {
    text = stripTrailingProjectableWhitespace(text);
  }
  return text;
}

export function computeCommittedDelta(
  rawCommitted: string,
  dispatchedProjectedLength: number,
  options: ProjectCommittedTextOptions = {},
): string {
  const projected = projectCommittedText(rawCommitted, dispatchedProjectedLength, options);
  if (dispatchedProjectedLength > projected.length) {
    return '';
  }
  return projected.slice(dispatchedProjectedLength);
}

export function hasMalformedControlCharacters(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x00) return true;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function countUtf16CodeUnits(text: string): number {
  return text.length;
}

export function exceedsUnicodeDispatchLimit(text: string): boolean {
  return countUtf16CodeUnits(text) > LIVE_UNICODE_DISPATCH_CODE_UNIT_LIMIT;
}

export function expectedUnicodeEventCount(text: string): number {
  return countUtf16CodeUnits(text) * 2;
}

export function interpretUnicodeDispatch(
  acceptedEvents: number,
  expectedEvents: number,
  _errorCode?: number,
): UnicodeDispatchInterpretation {
  if (acceptedEvents === 0) {
    return {
      certainty: 'none-accepted',
      recovery: 'retry-safe',
      advanceCursor: false,
    };
  }
  if (acceptedEvents === expectedEvents) {
    return {
      certainty: 'os-accepted-all',
      recovery: 'copy-only',
      advanceCursor: true,
    };
  }
  return {
    certainty: 'ambiguous-partial',
    recovery: 'halt',
    advanceCursor: false,
  };
}

export function validateExactTarget(
  original: DictationTargetSnapshot,
  current: DictationTargetSnapshot | null,
): { allowed: true } | { allowed: false; reason: string } {
  if (!current) {
    return { allowed: false, reason: 'target-changed: foreground target is missing or invalid' };
  }
  if (original.processId !== current.processId) {
    return { allowed: false, reason: 'target-changed: focus moved to a different process' };
  }
  if (original.processCreationTime !== current.processCreationTime) {
    return { allowed: false, reason: 'target-changed: original process identity is no longer valid' };
  }
  if (original.hwnd !== current.hwnd) {
    return { allowed: false, reason: 'target-changed: foreground window is not the original target' };
  }
  if (
    original.executablePath
    && current.executablePath
    && original.executablePath.toLowerCase() !== current.executablePath.toLowerCase()
  ) {
    return {
      allowed: false,
      reason: 'target-changed: executable path no longer matches the original target',
    };
  }
  return { allowed: true };
}

export function outerTrimTranscript(text: string): string {
  return stripLeadingProjectableWhitespace(stripTrailingProjectableWhitespace(text));
}
