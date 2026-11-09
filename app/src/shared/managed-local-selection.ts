import { z } from 'zod';
export const managedLocalModelSchema = z.enum(['parakeet', 'granite']);
export const managedLocalDeviceSchema = z.enum(['auto', 'cpu', 'cuda']);

export const managedLocalSelectionSchema = z.object({
  model: managedLocalModelSchema,
  devices: z.object({
    parakeet: managedLocalDeviceSchema,
    granite: managedLocalDeviceSchema,
  }),
});

export type ManagedLocalSelection = z.infer<typeof managedLocalSelectionSchema>;

export const DEFAULT_MANAGED_LOCAL: ManagedLocalSelection = {
  model: 'parakeet',
  devices: { parakeet: 'auto', granite: 'auto' },
};

export function resolveManagedLocalSelection(value: unknown): ManagedLocalSelection {
  return managedLocalSelectionSchema.safeParse(value).data ?? structuredClone(DEFAULT_MANAGED_LOCAL);
}

export function managedLocalSupportsDictionary(model: ManagedLocalSelection['model']): boolean {
  return model === 'parakeet';
}
