import type { PlatformCapabilityStatus, ShortcutBinding, ShortcutRegistrationStatus } from '../../types/ipc';

export type ShortcutValidationResult =
  | { ok: true; status: Extract<ShortcutRegistrationStatus, 'ready'> }
  | { ok: false; status: Exclude<ShortcutRegistrationStatus, 'ready'>; message: string };

const actionLabels: Record<string, string> = {
  dictation: 'Dictation',
  agent: 'Agent Mode',
};

export function validateShortcutBinding(
  candidate: ShortcutBinding,
  existing: Record<string, ShortcutBinding>,
  capabilities?: Partial<Record<ShortcutBinding['action'], PlatformCapabilityStatus>>
): ShortcutValidationResult {
  if (!candidate.accelerator) {
    return { ok: false, status: 'unassigned', message: 'Press a shortcut to assign this action.' };
  }

  const capability = capabilities?.[candidate.action];
  if (capability && capability.state !== 'ready') {
    return { ok: false, status: capability.state, message: capability.message };
  }

  const conflict = Object.values(existing).find(
    (binding) => binding.action !== candidate.action && binding.accelerator === candidate.accelerator
  );

  if (conflict) {
    return {
      ok: false,
      status: 'conflict',
      message: `Already used by ${actionLabels[conflict.action] ?? conflict.action}.`,
    };
  }

  return { ok: true, status: 'ready' };
}
