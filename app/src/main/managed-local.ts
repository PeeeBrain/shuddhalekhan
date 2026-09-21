import { TranscriptionFailure } from './transcription';
import { createManagedLocalModelManager } from './managed-local-model';
import { createManagedLocalTranscriber } from './managed-local-runtime';
import type { ManagedLocalModelState } from '../types/ipc';

type ModelManager = ReturnType<typeof createManagedLocalModelManager>;

let modelManager: ModelManager | null = null;

export const managedLocalTranscriber = createManagedLocalTranscriber({
  async getModelPath() {
    const state = await requireModelManager().getState();
    if (state.kind !== 'ready') {
      throw new TranscriptionFailure(
        'model',
        state.kind === 'error'
          ? state.message
          : 'Install the local speech model in Settings before using Dictation.',
      );
    }
    return state.path;
  },
});

export function configureManagedLocal({
  root,
  onStateChanged,
}: {
  root: string;
  onStateChanged: (state: ManagedLocalModelState) => void;
}): void {
  if (modelManager) return;
  modelManager = createManagedLocalModelManager({ root, onStateChanged });
}

export function getManagedLocalModelManager(): ModelManager {
  return requireModelManager();
}

function requireModelManager(): ModelManager {
  if (!modelManager) throw new Error('Managed Local is not initialized.');
  return modelManager;
}
