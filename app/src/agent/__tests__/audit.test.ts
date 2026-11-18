import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import { AgentAuditStore, sanitizeAuditPayload } from '../audit';
import { queryAuditRunDetail } from '../../main/audit-queries';

const require = createRequire(import.meta.url);
const { Database } = require('bun:sqlite') as {
  Database: new (path: string, options?: { readonly?: boolean }) => {
    prepare(sql: string): { all(...args: string[]): unknown[] };
    close(throwOnError?: boolean): void;
  };
};

describe('sanitizeAuditPayload', () => {
  it('redacts credential assignments embedded in audit text', () => {
    expect(sanitizeAuditPayload({ text: 'password=hunter2 access_token=private id_token=jwt' }))
      .toEqual({ text: 'password=[redacted] access_token=[redacted] id_token=[redacted]' });
  });
  it('redacts secret-looking keys and bearer values', () => {
    expect(
      sanitizeAuditPayload({
        Authorization: 'Bearer abc.def',
        nested: {
          refresh_token: 'token',
          text: 'use sk-test-value here',
        },
      })
    ).toEqual({
      Authorization: '[redacted]',
      nested: {
        refresh_token: '[redacted]',
        text: 'use [redacted] here',
      },
    });
  });
});

describe('AgentAuditStore', () => {
  it('stores status changes without repeated entries in each run timeline', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-audit-'));
    const dbPath = join(directory, 'agent-audit.sqlite');
    try {
      const store = new AgentAuditStore(dbPath);
      store.record('run-1', 'status', { status: 'Thinking...' });
      store.record('run-1', 'status', { status: 'Thinking...' });
      store.record('run-1', 'status', { status: 'Calling tool...' });
      store.record('run-1', 'status', { status: 'Calling tool...' });
      store.record('run-2', 'status', { status: 'Calling tool...' });
      store.close();

      const db = new Database(dbPath, { readonly: true });
      try {
        const timeline = (runId: string) => queryAuditRunDetail(db, runId).map(event => [event.eventType, event.payload]);
        expect(timeline('run-1')).toEqual([
          ['status', { status: 'Thinking...' }],
          ['status', { status: 'Calling tool...' }],
        ]);
        expect(timeline('run-2')).toEqual([['status', { status: 'Calling tool...' }]]);
      } finally {
        db.close(true);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
