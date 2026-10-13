import { expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomicFile } from '../../atomic-file';

it('preserves the prior file and removes the temporary copy when the OS rejects replacement', () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'shuddha-atomic-'));
  const path = join(directory, 'agent-memory.md');
  fs.writeFileSync(path, '# Memory\n\n- Existing fact.\n');
  const rename = spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('Disk replacement failed.'); });
  try {
    expect(() => writeAtomicFile(path, '# Memory\n\n- New fact.\n')).toThrow('Disk replacement failed');
    expect(fs.readFileSync(path, 'utf8')).toBe('# Memory\n\n- Existing fact.\n');
    expect(fs.readdirSync(directory)).toEqual(['agent-memory.md']);
  } finally {
    rename.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
