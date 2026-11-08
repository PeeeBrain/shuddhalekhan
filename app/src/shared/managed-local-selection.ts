import { z } from 'zod';
import type { ManagedLocalSelection } from '../types/ipc';

export const managedLocalSelectionSchema = z.object({
  model: z.enum(['parakeet', 'granite']),
  devices: z.object({
    parakeet: z.enum(['auto', 'cpu', 'cuda']),
    granite: z.enum(['auto', 'cpu', 'cuda']),
  }),
});

export const DEFAULT_MANAGED_LOCAL: ManagedLocalSelection = {
  model: 'parakeet',
  devices: { parakeet: 'auto', granite: 'auto' },
};

export function resolveManagedLocalSelection(value: unknown): ManagedLocalSelection {
  return managedLocalSelectionSchema.safeParse(value).data ?? structuredClone(DEFAULT_MANAGED_LOCAL);
}
