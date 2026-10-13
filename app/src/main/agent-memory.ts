import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEMORY_BYTE_LIMIT, MEMORY_FACT_LIMIT, memoryFactsSchema, memoryUpdatesSchema, type AgentMemorySnapshot, type AgentMemoryCommitResult } from '../shared/agent-context';
import { writeAtomicFile } from '../shared/atomic-file';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const toMarkdown = (facts: string[]) => `# Memory\n\n${facts.map(text => `- ${text}\n`).join('')}`;

export class AgentMemoryStore {
  private generation = 0;
  private status: string | null = null;
  private readonly path: string;

  constructor(private readonly directory: string) {
    this.path = join(directory, 'agent-memory.md');
  }

  invalidate(): void { this.generation += 1; }

  setStatus(status: string): void { this.status = status; }

  snapshot(): AgentMemorySnapshot {
    let raw = '';
    try {
      if (existsSync(this.path)) {
        const stat = lstatSync(this.path);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Memory must be a regular Markdown file.');
        if (stat.size > MEMORY_BYTE_LIMIT) throw new Error('Memory exceeds the 8 KiB limit. Shorten agent-memory.md or clear memory.');
        raw = readFileSync(this.path, 'utf8');
      }
      const lines = raw.split(/\r?\n/).filter(line => line.trim() && !/^#{1,6}\s/.test(line));
      if (lines.some(line => !line.startsWith('- '))) throw new Error('Memory must contain one fact per Markdown bullet. Fix agent-memory.md or clear memory.');
      const facts = memoryFactsSchema.parse(lines.map(line => line.slice(2)));
      if (new Set(facts).size !== facts.length) throw new Error('Memory contains duplicate facts. Remove duplicate bullets or clear memory.');
      return { revision: `${this.generation}:${hash(raw)}`, markdown: facts.length ? toMarkdown(facts) : '', facts: facts.map(text => ({ id: hash(text), text })), status: this.status, error: null };
    } catch (error) {
      return { revision: `${this.generation}:${hash(raw)}`, markdown: '', facts: [], status: this.status, error: error instanceof Error ? error.message : 'Memory could not be read.' };
    }
  }

  edit(revision: string, id: string, text: string): AgentMemorySnapshot {
    const snapshot = this.current(revision);
    if (!snapshot.facts.some(fact => fact.id === id)) throw new Error('This fact changed. Refresh memory and try again.');
    return this.write(snapshot.facts.map(fact => fact.id === id ? text : fact.text));
  }

  remove(revision: string, id: string): AgentMemorySnapshot {
    const snapshot = this.current(revision);
    if (!snapshot.facts.some(fact => fact.id === id)) throw new Error('This fact changed. Refresh memory and try again.');
    return this.write(snapshot.facts.filter(fact => fact.id !== id).map(fact => fact.text));
  }

  clear(revision: string): AgentMemorySnapshot {
    this.current(revision, true);
    return this.write([]);
  }

  commit(revision: string, input: unknown): AgentMemoryCommitResult {
    try {
      const snapshot = this.current(revision);
      const updates = memoryUpdatesSchema.parse(input);
      const facts = snapshot.facts.map(fact => fact.text);
      let skipped = false;
      for (const update of updates) {
        const index = update.previous === null ? -1 : facts.indexOf(update.previous);
        if (update.previous !== null && index < 0) throw new Error('A proposed fact no longer exists.');
        if (facts.includes(update.text)) {
          if (index >= 0 && update.previous !== update.text) facts.splice(index, 1);
          continue;
        }
        const candidate = [...facts];
        if (index < 0) candidate.push(update.text);
        else candidate[index] = update.text;
        if (candidate.length > MEMORY_FACT_LIMIT || Buffer.byteLength(toMarkdown(candidate)) > MEMORY_BYTE_LIMIT) {
          skipped = true;
          continue;
        }
        facts.splice(0, facts.length, ...candidate);
      }
      if (facts.join('\n') !== snapshot.facts.map(fact => fact.text).join('\n')) this.write(facts);
      this.status = skipped ? 'Memory is full. Some new facts were skipped.' : updates.length ? 'Memory updated.' : 'No new facts to remember.';
      return { saved: true, ...(skipped ? { message: this.status } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Memory could not be saved.';
      this.status = message;
      return { saved: false, message };
    }
  }

  private current(revision: string, allowInvalid = false): AgentMemorySnapshot {
    const snapshot = this.snapshot();
    if (snapshot.revision !== revision) throw new Error('Memory changed. Refresh and try again.');
    if (snapshot.error && !allowInvalid) throw new Error(snapshot.error);
    return snapshot;
  }

  private write(input: string[]): AgentMemorySnapshot {
    const facts = [...new Set(memoryFactsSchema.parse(input))];
    const markdown = toMarkdown(facts);
    if (Buffer.byteLength(markdown) > MEMORY_BYTE_LIMIT) throw new Error('Memory exceeds the 8 KiB limit. Shorten or remove a fact.');
    // Never follow a manually substituted memory symlink, including on Clear.
    if (existsSync(this.path) && lstatSync(this.path).isSymbolicLink()) throw new Error('Memory must not be a symbolic link.');
    mkdirSync(this.directory, { recursive: true });
    writeAtomicFile(this.path, markdown);
    this.generation += 1;
    this.status = facts.length ? 'Memory updated.' : 'Memory cleared.';
    return this.snapshot();
  }
}
