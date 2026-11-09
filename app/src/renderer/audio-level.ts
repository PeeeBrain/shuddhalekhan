const listeners = new Set<(level: number) => void>();

export function publishAudioLevel(level: number): void {
  for (const listener of listeners) listener(level);
}

export function subscribeAudioLevel(listener: (level: number) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
