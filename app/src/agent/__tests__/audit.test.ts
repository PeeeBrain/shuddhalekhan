import { describe, expect, it } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { AgentAuditStore, sanitizeAuditPayload } from '../audit';

const require = createRequire(import.meta.url);
const { Database } = require('bun:sqlite') as {
  Database: new (path: string, options?: { readonly?: boolean }) => {
    query(sql: string): {
      get(): unknown;
      all(): unknown[];
      finalize(): void;
    };
    close(): void;
  };
};

describe('sanitizeAuditPayload', () => {
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
  const testDir = join(process.cwd(), '.tmp-agent-audit-test');
  const dbPath = join(testDir, 'agent-audit.sqlite');

  function cleanup(): void {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  }

  it('creates and writes the audit database under Bun runtime', () => {
    cleanup();

    try {
      const store = new AgentAuditStore(dbPath);
      store.record('run-1', 'status', { status: 'Thinking...' });
      store.close();

      const db = new Database(dbPath, { readonly: true });
      const select = db.query('SELECT agent_run_id, event_type, payload_json FROM agent_audit_events');
      const row = select.get() as {
        agent_run_id: string;
        event_type: string;
        payload_json: string;
      };
      select.finalize();
      db.close();

      expect(row.agent_run_id).toBe('run-1');
      expect(row.event_type).toBe('status');
      expect(JSON.parse(row.payload_json)).toEqual({ status: 'Thinking...' });
    } finally {
      cleanup();
    }
  });

  it('suppresses consecutive equivalent status events for the same run', () => {
    cleanup();

    try {
      const store = new AgentAuditStore(dbPath);
      store.record('run-1', 'status', { status: 'Thinking...' });
      store.record('run-1', 'status', { status: 'Thinking...' });
      store.record('run-1', 'status', { status: 'Calling tool...' });
      store.record('run-1', 'status', { status: 'Calling tool...' });
      store.record('run-2', 'status', { status: 'Calling tool...' });
      store.close();

      const db = new Database(dbPath, { readonly: true });
      const select = db.query('SELECT agent_run_id, event_type, payload_json FROM agent_audit_events ORDER BY id ASC');
      const rows = select.all() as {
        agent_run_id: string;
        event_type: string;
        payload_json: string;
      }[];
      select.finalize();
      db.close();

      expect(rows.map((row) => [row.agent_run_id, JSON.parse(row.payload_json).status])).toEqual([
        ['run-1', 'Thinking...'],
        ['run-1', 'Calling tool...'],
        ['run-2', 'Calling tool...'],
      ]);
    } finally {
      cleanup();
    }
  });
});
