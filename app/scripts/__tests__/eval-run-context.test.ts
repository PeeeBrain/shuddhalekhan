import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { modelIdentity, shuffled } from '../eval/run-context';

test('saved model identity distinguishes changed files at the same path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eval-model-'));
  try {
    writeFileSync(join(directory, 'tokens.txt'), 'abc');
    const before = modelIdentity(directory, ['tokens.txt']);
    expect(before.files['tokens.txt']).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    writeFileSync(join(directory, 'tokens.txt'), 'abcd');
    expect(modelIdentity(directory, ['tokens.txt']).files['tokens.txt']).not.toBe(before.files['tokens.txt']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('three timing clips can reach all six permutations without changing the subset', () => {
  const random = spyOn(Math, 'random');
  const orders = new Set<string>();
  const subset = [0, 1, 2];
  try {
    for (let first = 0; first < 3; first++) {
      for (let second = 0; second < 2; second++) {
        random.mockReturnValueOnce((first + 0.5) / 3).mockReturnValueOnce((second + 0.5) / 2);
        orders.add(shuffled(subset).join(','));
      }
    }
    expect(orders.size).toBe(6);
    expect(subset).toEqual([0, 1, 2]);
  } finally {
    random.mockRestore();
  }
});
