import { describe, expect, it } from 'bun:test';
import {
  getNextListboxIndex,
  isListboxActivateKey,
  isListboxNavKey,
} from '../audit-history-nav';

describe('isListboxNavKey', () => {
  it('recognizes the four arrow/home/end keys', () => {
    expect(isListboxNavKey('ArrowDown')).toBe(true);
    expect(isListboxNavKey('ArrowUp')).toBe(true);
    expect(isListboxNavKey('Home')).toBe(true);
    expect(isListboxNavKey('End')).toBe(true);
  });

  it('rejects non-navigation keys', () => {
    expect(isListboxNavKey('Enter')).toBe(false);
    expect(isListboxNavKey(' ')).toBe(false);
    expect(isListboxNavKey('a')).toBe(false);
  });
});

describe('isListboxActivateKey', () => {
  it('recognizes Enter and Space', () => {
    expect(isListboxActivateKey('Enter')).toBe(true);
    expect(isListboxActivateKey(' ')).toBe(true);
  });

  it('rejects navigation and letter keys', () => {
    expect(isListboxActivateKey('ArrowDown')).toBe(false);
    expect(isListboxActivateKey('Home')).toBe(false);
    expect(isListboxActivateKey('a')).toBe(false);
  });
});

describe('getNextListboxIndex', () => {
  it('moves down by one and clamps at the last item', () => {
    expect(getNextListboxIndex(2, 'ArrowDown', 5)).toBe(3);
    expect(getNextListboxIndex(4, 'ArrowDown', 5)).toBe(4);
  });

  it('moves up by one and clamps at the first item', () => {
    expect(getNextListboxIndex(2, 'ArrowUp', 5)).toBe(1);
    expect(getNextListboxIndex(0, 'ArrowUp', 5)).toBe(0);
  });

  it('jumps to the first item on Home', () => {
    expect(getNextListboxIndex(3, 'Home', 5)).toBe(0);
    expect(getNextListboxIndex(0, 'Home', 5)).toBe(0);
  });

  it('jumps to the last item on End', () => {
    expect(getNextListboxIndex(1, 'End', 5)).toBe(4);
    expect(getNextListboxIndex(4, 'End', 5)).toBe(4);
  });

  it('handles a single-item list without going out of bounds', () => {
    expect(getNextListboxIndex(0, 'ArrowDown', 1)).toBe(0);
    expect(getNextListboxIndex(0, 'ArrowUp', 1)).toBe(0);
    expect(getNextListboxIndex(0, 'Home', 1)).toBe(0);
    expect(getNextListboxIndex(0, 'End', 1)).toBe(0);
  });

  it('handles a no-selection start (currentIndex -1) by landing on item 0 for Arrow Down', () => {
    expect(getNextListboxIndex(-1, 'ArrowDown', 5)).toBe(0);
  });
});
