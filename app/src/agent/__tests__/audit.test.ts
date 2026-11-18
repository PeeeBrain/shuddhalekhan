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
  it('keeps Computer Use arguments, UI text, and model copies out of SQLite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-audit-'));
    const dbPath = join(directory, 'agent-audit.sqlite');
    const marker = 'private-desktop-fixture-19f1';
    try {
      const store = new AgentAuditStore(dbPath);
      const run = store.forExecution('native-run');
      const toolName = 'native-computer__desktop_set_value';
      const nativeCall = { toolName, toolCallId: 'call', input: { value: marker } };
      const ordinaryCall = { toolName: 'mail__search', input: { query: 'keep-mcp-arguments' } };
      run.record('tool_requests', { toolCalls: [nativeCall, ordinaryCall] });
      run.record('tool_approval_requests', { approvalRequests: [{ approvalId: 'sdk', toolCall: nativeCall }] });
      run.record('tool_approval_responses_sent', { approvalResponses: [{ approvalId: 'sdk', reason: marker }] });
      run.record('approval_requested', { serverId: 'native-computer', arguments: [marker] });
      run.record('approval_decision', { serverId: 'native-computer', approved: false, message: marker });
      run.markComputerUseExecuted();
      run.record('tool_results', { toolResults: [{ ...nativeCall, output: marker }] });
      run.record('mcp_tool_execute_started', { serverId: 'mail', toolName: 'search', arguments: marker });
      run.record('computer_use_tool_execute', { toolName: 'desktop_set_value', ok: true, durationMs: 2, resultBytes: 10 });
      run.record('run_completed', { response: marker, toolSummary: [] });
      store.close();

      const db = new Database(dbPath, { readonly: true });
      try {
        const events = queryAuditRunDetail(db, 'native-run');
        expect(JSON.stringify(events)).not.toContain(marker);
        expect(events.find(event => event.eventType === 'run_completed')?.payload).toEqual({ toolSummary: [] });
        expect(events.find(event => event.eventType === 'tool_requests')?.payload).toEqual({
          toolCalls: [{ toolName, toolCallId: 'call' }, ordinaryCall],
        });
        expect(events.find(event => event.eventType === 'computer_use_tool_execute')?.payload).toMatchObject({
          toolName: 'desktop_set_value', ok: true, resultBytes: 10,
        });
      } finally {
        db.close(true);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
