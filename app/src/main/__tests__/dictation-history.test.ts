import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  DICTATION_HISTORY_MAX_ENTRIES,
  DICTATION_HISTORY_PAGE_SIZE,
  DICTATION_HISTORY_PREVIEW_CHARS,
  DictationHistory,
  deliveryOf,
  type HistoryDatabase,
} from '../dictation-history';
import type { DictationHistoryEntry } from '../../types/ipc';
import { openAuditDatabase } from '../../shared/audit-sqlite';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A file-backed store, so reopening it is a restart. */
function open(days: { value: number }) {
  if (!dirs.length) dirs.push(mkdtempSync(join(tmpdir(), 'dictation-history-')));
  return new DictationHistory(openAuditDatabase(join(dirs[0], 'history.sqlite')) as unknown as HistoryDatabase, () => days.value);
}

const entry = (text: string, overrides: Partial<DictationHistoryEntry> = {}) => ({
  createdAt: new Date().toISOString(), text, rawText: null, provider: 'openai' as const,
  model: 'gpt-4o-transcribe', delivery: 'dispatched' as const, ...overrides,
});

describe('Dictation history', () => {
  it('survives a restart and finds an earlier Dictation by final or raw text', () => {
    const days = { value: 30 };
    const first = open(days);
    const id = first.record(entry('Send the report Friday', { rawText: 'um send the report friday', delivery: 'failed' }))!;
    first.record(entry('A later dictation'));

    const reopened = open(days);
    expect(reopened.list('REPORT', null).entries.map(row => row.id)).toEqual([id]);
    expect(reopened.list('um send', null).entries.map(row => row.id)).toEqual([id]);
    expect(reopened.list('100%', null).entries).toEqual([]);
    expect(reopened.get(id)).toMatchObject({ text: 'Send the report Friday', rawText: 'um send the report friday', delivery: 'failed' });
  });

  it('saves nothing while off, and turning it off or shortening retention deletes what it no longer keeps', () => {
    const days = { value: 30 };
    const history = open(days);
    const oldId = history.record(entry('old', { createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString() }))!;
    history.record(entry('recent'));

    days.value = 7;
    // A page left open past retention must not reopen or copy the expired entry.
    expect(history.get(oldId)).toBeNull();
    expect(history.list('', null).entries.map(row => row.text)).toEqual(['recent']);

    days.value = 0;
    expect(history.record(entry('while off'))).toBeNull();
    history.prune();
    days.value = 30;
    expect(open(days).list('', null).entries).toEqual([]);
  });

  it('calls a paste failed only when nothing can have been sent', () => {
    expect(deliveryOf({ kind: 'input-dispatched', acceptedEvents: 2 })).toBe('dispatched');
    expect(deliveryOf({ kind: 'target-changed', reason: 'moved' })).toBe('failed');
    expect(deliveryOf({ kind: 'input-blocked', acceptedEvents: 0 })).toBe('failed');
    expect(deliveryOf({ kind: 'input-blocked', acceptedEvents: 2, reason: 'Partial input dispatch' })).toBe('uncertain');
    expect(deliveryOf({ kind: 'clipboard-conflict', reason: 'changed after paste' })).toBe('uncertain');
    expect(deliveryOf({ kind: 'error', message: 'The clipboard could not be restored safely.' })).toBe('uncertain');
  });

  it('deletes one entry or all of them', () => {
    const history = open({ value: 30 });
    const a = history.record(entry('a'))!;
    history.record(entry('b'));
    history.delete(a);
    expect(history.list('', null).entries.map(row => row.text)).toEqual(['b']);
    history.clear();
    expect(history.list('', null).entries).toEqual([]);
  });

  it('bounds stored rows, page size, and list row text', () => {
    const history = open({ value: 30 });
    const long = 'x'.repeat(DICTATION_HISTORY_PREVIEW_CHARS + 50);
    const oldest = history.record(entry('oldest'))!;
    for (let i = 0; i < DICTATION_HISTORY_MAX_ENTRIES; i++) history.record(entry(i === DICTATION_HISTORY_MAX_ENTRIES - 1 ? long : `entry ${i}`));

    const first = history.list('', null);
    expect(first.entries).toHaveLength(DICTATION_HISTORY_PAGE_SIZE);
    expect(first.hasMore).toBe(true);
    expect(first.entries[0]).toMatchObject({ text: 'x'.repeat(DICTATION_HISTORY_PREVIEW_CHARS), truncated: true });
    expect(history.get(first.entries[0].id)?.text).toBe(long);

    let total = 0;
    let beforeId: number | null = null;
    for (;;) {
      const page = history.list('', beforeId);
      total += page.entries.length;
      if (!page.hasMore) break;
      beforeId = page.entries[page.entries.length - 1].id;
    }
    expect(total).toBe(DICTATION_HISTORY_MAX_ENTRIES);
    expect(history.get(oldest)).toBeNull();
  });
});
