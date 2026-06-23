export type ListboxNavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

export function isListboxNavKey(key: string): key is ListboxNavKey {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End';
}

export function isListboxActivateKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

export function getNextListboxIndex(
  currentIndex: number,
  key: ListboxNavKey,
  itemCount: number
): number {
  switch (key) {
    case 'ArrowDown':
      return Math.min(itemCount - 1, currentIndex + 1);
    case 'ArrowUp':
      return Math.max(0, currentIndex - 1);
    case 'Home':
      return 0;
    case 'End':
      return itemCount - 1;
  }
}
