'use strict';
/* eslint-disable @typescript-eslint/no-require-imports */
/* global clearTimeout, process, require, setImmediate, setTimeout */

const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');

const transport = process.parentPort ? 'utility-process' : 'stdio-sidecar';
const pendingWork = new Map();
let database;

function send(message) {
  if (process.parentPort) {
    process.parentPort.postMessage(message);
    return;
  }

  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function receive(handler) {
  if (process.parentPort) {
    process.parentPort.on('message', (event) => handler(event.data));
    return;
  }

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handler(JSON.parse(line));
      newline = buffer.indexOf('\n');
    }
  });
  process.stdin.resume();
}

async function boot() {
  const loadStartedAt = performance.now();
  await Promise.all([import('ai'), import('@ai-sdk/mcp'), import('@ai-sdk/openai-compatible')]);

  const Database = require('better-sqlite3');
  database = new Database(':memory:');
  database.exec(`
    CREATE TABLE prototype_audit (
      request_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL
    )
  `);

  receive(handleMessage);
  send({
    type: 'ready',
    transport,
    pid: process.pid,
    loadMs: performance.now() - loadStartedAt,
    processType: process.type ?? 'node',
    electron: process.versions.electron ?? null,
    node: process.versions.node,
  });
}

function handleMessage(message) {
  switch (message.type) {
    case 'ping':
      send({ type: 'pong', requestId: message.requestId });
      break;
    case 'work': {
      const startedAt = performance.now();
      const digest = createHash('sha256').update(message.payload).digest('hex');
      database
        .prepare('INSERT INTO prototype_audit (request_id, event_type, payload) VALUES (?, ?, ?)')
        .run(message.requestId, 'synthetic-work', digest);
      send({
        type: 'work:completed',
        requestId: message.requestId,
        workerMs: performance.now() - startedAt,
        auditRows: database.prepare('SELECT count(*) AS count FROM prototype_audit').get().count,
      });
      break;
    }
    case 'long-work': {
      const timeout = setTimeout(() => {
        pendingWork.delete(message.requestId);
        send({ type: 'long-work:completed', requestId: message.requestId });
      }, 2_000);
      pendingWork.set(message.requestId, timeout);
      send({ type: 'long-work:started', requestId: message.requestId });
      break;
    }
    case 'cancel': {
      const timeout = pendingWork.get(message.requestId);
      if (timeout) {
        clearTimeout(timeout);
        pendingWork.delete(message.requestId);
      }
      send({ type: 'cancelled', requestId: message.requestId, hadPendingWork: Boolean(timeout) });
      break;
    }
    case 'crash':
      setImmediate(() => process.exit(73));
      break;
    case 'shutdown':
      for (const timeout of pendingWork.values()) clearTimeout(timeout);
      pendingWork.clear();
      database?.close();
      send({ type: 'shutdown:complete' });
      setImmediate(() => process.exit(0));
      break;
  }
}

boot().catch((error) => {
  send({ type: 'fatal', error: error instanceof Error ? error.stack ?? error.message : String(error) });
  setImmediate(() => process.exit(1));
});
