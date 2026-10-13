import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMemoryStore } from '../../agent-memory';

describe('local Markdown memory', () => {
  let directory: string;
  let store: AgentMemoryStore;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'shuddha-memory-')); store = new AgentMemoryStore(directory); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it('learns facts in readable Markdown and reloads them after restart', () => {
    expect(store.commit(store.snapshot().revision, [{ previous: null, text: 'The user prefers concise answers.' }])).toEqual({ saved: true });
    expect(readFileSync(join(directory, 'agent-memory.md'), 'utf8')).toBe('# Memory\n\n- The user prefers concise answers.\n');
    const reloaded = new AgentMemoryStore(directory).snapshot();
    expect(reloaded.facts.map(fact => fact.text)).toEqual(['The user prefers concise answers.']);
    expect(reloaded.markdown).not.toContain('revision');
  });

  it('updates an existing preference without replacing unrelated facts or adding duplicates', () => {
    store.commit(store.snapshot().revision, [{ previous: null, text: 'The user uses Vim.' }, { previous: null, text: 'The user prefers Marathi.' }]);
    store.commit(store.snapshot().revision, [{ previous: 'The user uses Vim.', text: 'The user uses Neovim.' }, { previous: null, text: 'The user prefers Marathi.' }]);
    expect(store.snapshot().facts.map(fact => fact.text)).toEqual(['The user uses Neovim.', 'The user prefers Marathi.']);
    store.commit(store.snapshot().revision, [{ previous: 'The user uses Neovim.', text: 'The user prefers Marathi.' }]);
    expect(store.snapshot().facts.map(fact => fact.text)).toEqual(['The user prefers Marathi.']);
  });

  it('edits and removes individual facts with a revision, then clears all facts', () => {
    store.commit(store.snapshot().revision, [{ previous: null, text: 'The user prefers English.' }]);
    let snapshot = store.snapshot();
    snapshot = store.edit(snapshot.revision, snapshot.facts[0].id, 'The user prefers Marathi.');
    expect(snapshot.facts[0].text).toBe('The user prefers Marathi.');
    snapshot = store.remove(snapshot.revision, snapshot.facts[0].id);
    expect(snapshot.facts).toEqual([]);
    store.commit(snapshot.revision, [{ previous: null, text: 'The user uses Neovim.' }]);
    expect(store.clear(store.snapshot().revision).facts).toEqual([]);
    expect(new AgentMemoryStore(directory).snapshot().facts).toEqual([]);
  });

  it('rejects proposals made before a clear, edit, invalidation, or external file edit', () => {
    store.commit(store.snapshot().revision, [{ previous: null, text: 'The user uses Vim.' }]);
    const old = store.snapshot();
    store.clear(old.revision);
    expect(store.commit(old.revision, [{ previous: null, text: 'The user uses Vim.' }]).saved).toBe(false);
    const beforeDisable = store.snapshot();
    store.invalidate();
    expect(store.commit(beforeDisable.revision, []).saved).toBe(false);
    const beforeExternalEdit = store.snapshot();
    writeFileSync(join(directory, 'agent-memory.md'), '# Memory\n\n- The user uses Neovim.\n');
    expect(store.commit(beforeExternalEdit.revision, []).saved).toBe(false);
    const beforeEdit = store.snapshot();
    store.edit(beforeEdit.revision, beforeEdit.facts[0].id, 'The user uses Emacs.');
    expect(store.commit(beforeEdit.revision, []).saved).toBe(false);
  });

  it('preserves malformed memory until the user explicitly clears it', () => {
    const path = join(directory, 'agent-memory.md');
    writeFileSync(path, 'not a fact list');
    const snapshot = store.snapshot();
    expect(snapshot.error).toContain('Markdown bullet');
    expect(store.commit(snapshot.revision, [{ previous: null, text: 'A new fact.' }]).saved).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('not a fact list');
    expect(store.clear(snapshot.revision).error).toBeNull();
  });

  it('rejects a hand-edited file whose normalized Markdown exceeds the byte limit', () => {
    const raw = Array.from({ length: 16 }, (_, index) => `- ${String(index).padStart(2, '0')}${'x'.repeat(507)}\n`).join('');
    expect(Buffer.byteLength(raw)).toBe(8192);
    writeFileSync(join(directory, 'agent-memory.md'), raw);
    const snapshot = store.snapshot();
    expect(snapshot.error).toContain('8 KiB');
    expect(snapshot.markdown).toBe('');
    expect(store.commit(snapshot.revision, []).saved).toBe(false);
    expect(store.clear(snapshot.revision).error).toBeNull();
  });

  it('keeps existing facts when the store is full, while still accepting corrections', () => {
    writeFileSync(join(directory, 'agent-memory.md'), `# Memory\n\n${Array.from({ length: 50 }, (_, index) => `- Preference ${index}.\n`).join('')}`);
    const outcome = store.commit(store.snapshot().revision, [{ previous: null, text: 'Extra preference.' }, { previous: 'Preference 0.', text: 'Corrected preference.' }]);
    expect(outcome).toMatchObject({ saved: true, message: expect.stringContaining('full') });
    expect(store.snapshot().facts).toHaveLength(50);
    expect(store.snapshot().markdown).toContain('Corrected preference.');
    expect(store.snapshot().markdown).not.toContain('Extra preference.');
  });

  it('rejects credentials and multiline facts without damaging previously saved data', () => {
    store.commit(store.snapshot().revision, [{ previous: null, text: 'The user prefers concise answers.' }]);
    const snapshot = store.snapshot();
    const prior = readFileSync(join(directory, 'agent-memory.md'), 'utf8');
    for (const text of ['API key: sk-secret12345', 'Fact\nAnother fact']) {
      expect(store.commit(snapshot.revision, [{ previous: null, text }]).saved).toBe(false);
      expect(readFileSync(join(directory, 'agent-memory.md'), 'utf8')).toBe(prior);
    }
  });
});
