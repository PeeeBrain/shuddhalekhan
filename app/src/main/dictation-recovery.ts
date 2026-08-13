import type { DictationRecoveryAction, InjectResult } from '../types/ipc';

export function getRecoveryActions(result: InjectResult): DictationRecoveryAction[] {
  const definitelyAcceptedNothing = result.kind === 'target-changed'
    || result.kind === 'clipboard-conflict'
    || (result.kind === 'input-blocked' && result.acceptedEvents === 0);
  return definitelyAcceptedNothing
    ? ['retry-paste', 'copy-full-transcript']
    : ['copy-full-transcript'];
}
