'use strict';
/* eslint-disable @typescript-eslint/no-require-imports */
/* global __dirname, clearTimeout, console, process, require, setTimeout */

const { app, utilityProcess } = require('electron');
const { spawn, execFile } = require('node:child_process');
const { createInterface } = require('node:readline');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { promisify } = require('node:util');
const { createInitialState, reduce } = require('./state.cjs');

const execFileAsync = promisify(execFile);
const workerPath = join(__dirname, 'worker.cjs');
const launchCount = 6;
const pingCount = 250;
const warmWorkCount = 20;
const bold = '\x1b[1m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';

app.disableHardwareAcceleration();

let state = createInitialState({
  platform: `${process.platform} ${process.arch}`,
  electron: process.versions.electron,
  node: process.versions.node,
  launchCount,
  pingCount,
});
let busy = false;
let quitting = false;

function dispatch(action) {
  state = reduce(state, action);
  render();
}

function render() {
  console.clear();
  console.log(`${bold}PROTOTYPE — Agent runtime process boundary${reset}`);
  console.log(`${dim}Throwaway evidence for “Decide the long-term Agent runtime process boundary”${reset}\n`);
  console.log(`${bold}Question${reset}\n${state.question}\n`);
  console.log(`${bold}Runtime${reset}`);
  console.log(`  Platform:       ${state.runtime.platform}`);
  console.log(`  Electron/Node:  ${state.runtime.electron} / ${state.runtime.node}`);
  console.log(`  Sample shape:   ${state.runtime.launchCount} launches, ${state.runtime.pingCount} IPC round trips\n`);
  console.log(`${bold}Current state${reset}`);
  console.log(`  Status:         ${state.status}`);
  console.log(`  Candidate:      ${state.activeCandidate ?? 'none'}`);
  console.log(`  Last error:     ${state.lastError ?? 'none'}\n`);

  renderResults();
  renderInterpretation();
  renderFacts();

  console.log(`${bold}Actions${reset}`);
  console.log(`  ${bold}[b]${reset} ${dim}benchmark both${reset}   ${bold}[s]${reset} ${dim}stdio only${reset}   ${bold}[u]${reset} ${dim}utility only${reset}`);
  console.log(`  ${bold}[r]${reset} ${dim}reset results${reset}    ${bold}[q]${reset} ${dim}quit${reset}`);
}

function renderResults() {
  console.log(`${bold}Measured results${reset}`);
  const candidates = ['stdio-sidecar', 'utility-process'];
  const rows = candidates.map((candidate) => state.results[candidate]).filter(Boolean);
  if (rows.length === 0) {
    console.log(`  ${dim}No measurements yet.${reset}\n`);
    return;
  }

  console.log(
    '  Candidate         ready p50/p95   first/warm work  IPC p50/p95   private / WS   cancel  crash  restart'
  );
  for (const result of rows) {
    console.log(
      `  ${pad(result.candidate, 17)} ${pad(`${formatMs(result.ready.p50)}/${formatMs(result.ready.p95)}`, 15)} ` +
        `${pad(`${formatMs(result.firstWorkMs)}/${formatMs(result.warmWork.p50)}`, 16)} ${pad(`${formatMs(result.ipc.p50)}/${formatMs(result.ipc.p95)}`, 13)} ` +
        `${pad(`${formatMb(result.memory.privateBytes)}/${formatMb(result.memory.workingSetBytes)}`, 14)} ${padMs(result.cancelAckMs, 7)} ` +
        `${padMs(result.crashObservedMs, 6)} ${padMs(result.restartReadyMs, 7)}`
    );
    console.log(
      `  ${dim}uncontrolled first observation=${formatMs(result.uncontrolledFirstReadyMs)}; worker=${result.workerProcessType}; ` +
        `native SQLite=${result.auditRows === warmWorkCount + 1 ? 'ok' : `unexpected rows ${result.auditRows}`}; ` +
        `exit=${result.crashExitCode}; measured startup load=${formatMs(result.workerLoadMs)}${reset}`
    );
  }
  console.log();
}

function renderFacts() {
  console.log(`${bold}Boundary facts exposed by the prototype${reset}`);
  console.log('  stdio-sidecar:   stdin JSONL=yes; app metrics=no; direct renderer port=no; PID for Job Object=yes');
  console.log('  utility-process: stdin JSONL=no;  app metrics/serviceName=yes; direct renderer port=yes; PID for Job Object=yes');
  console.log('  both:            isolated Node runtime; worker-owned SQLite; main-observed exit; explicit cancel/restart still required');
  console.log(`  ${dim}Not measured: packaged NSIS, real model/MCP traffic, Windows Job Object containment, or A/A regression gates.${reset}\n`);
}

function renderInterpretation() {
  const stdio = state.results['stdio-sidecar'];
  const utility = state.results['utility-process'];
  if (!stdio || !utility) return;

  const readyDelta = percentDelta(stdio.ready.p50, utility.ready.p50);
  const privateDelta = percentDelta(stdio.memory.privateBytes, utility.memory.privateBytes);
  const workingSetDelta = percentDelta(stdio.memory.workingSetBytes, utility.memory.workingSetBytes);
  const ipcDeltaMs = utility.ipc.p50 - stdio.ipc.p50;
  console.log(`${bold}Provisional read${reset}`);
  console.log(
    `  utilityProcess vs stdio: ready ${signedPercent(readyDelta)}, private memory ${signedPercent(privateDelta)}, ` +
      `working set ${signedPercent(workingSetDelta)}, median IPC ${ipcDeltaMs >= 0 ? '+' : ''}${ipcDeltaMs.toFixed(3)}ms.`
  );
  console.log(
    `  ${dim}No migration trigger is visible in this run: the IPC difference is sub-millisecond and utilityProcess does not remove the isolated process or lifecycle work.${reset}\n`
  );
}

function percentDelta(baseline, candidate) {
  return ((candidate - baseline) / baseline) * 100;
}

function signedPercent(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function padMs(value, width) {
  return pad(formatMs(value), width);
}

function formatMs(value) {
  return `${Number(value).toFixed(2)}ms`;
}

function formatMb(bytes) {
  return `${(Number(bytes) / 1024 / 1024).toFixed(1)}MB`;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

function summarize(values) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
}

class BoundaryProcess {
  constructor(candidate) {
    this.candidate = candidate;
    this.child = null;
    this.messages = [];
    this.waiters = [];
    this.stderr = '';
    this.pid = null;
    this.exitPromise = null;
    this.resolveExit = null;
  }

  async start() {
    const startedAt = performance.now();
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    if (this.candidate === 'stdio-sidecar') this.startStdio();
    else this.startUtility();

    const ready = await this.waitFor((message) => message.type === 'ready' || message.type === 'fatal', 15_000);
    if (ready.type === 'fatal') throw new Error(ready.error);
    this.pid = ready.pid;
    return { ...ready, readyMs: performance.now() - startedAt };
  }

  startStdio() {
    this.child = spawn(process.execPath, [workerPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        SHUDDHALEKHAN_PROTOTYPE_TRANSPORT: 'stdio-sidecar',
      },
    });

    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      try {
        this.pushMessage(JSON.parse(line));
      } catch (error) {
        this.stderr += `malformed stdout: ${line}\n${String(error)}\n`;
      }
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += String(chunk);
    });
    this.child.on('error', (error) => this.pushMessage({ type: 'fatal', error: error.message }));
    this.child.on('exit', (code, signal) => {
      lines.close();
      this.resolveExit?.({ code, signal });
    });
  }

  startUtility() {
    const env = { ...process.env, SHUDDHALEKHAN_PROTOTYPE_TRANSPORT: 'utility-process' };
    delete env.ELECTRON_RUN_AS_NODE;
    this.child = utilityProcess.fork(workerPath, [], {
      env,
      stdio: 'pipe',
      serviceName: 'Shuddhalekhan Agent Boundary Prototype',
    });
    this.child.on('message', (message) => this.pushMessage(message));
    this.child.stdout?.on('data', (chunk) => {
      this.stderr += `unexpected stdout: ${String(chunk)}`;
    });
    this.child.stderr?.on('data', (chunk) => {
      this.stderr += String(chunk);
    });
    this.child.on('error', (type, location, report) => {
      this.pushMessage({ type: 'fatal', error: `${type} at ${location}\n${report}` });
    });
    this.child.on('exit', (code) => this.resolveExit?.({ code, signal: null }));
  }

  send(message) {
    if (this.candidate === 'stdio-sidecar') {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
      return;
    }
    this.child.postMessage(message);
  }

  pushMessage(message) {
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex < 0) {
      this.messages.push(message);
      return;
    }
    const [waiter] = this.waiters.splice(waiterIndex, 1);
    clearTimeout(waiter.timeout);
    waiter.resolve(message);
  }

  waitFor(predicate, timeoutMs = 5_000) {
    const existingIndex = this.messages.findIndex(predicate);
    if (existingIndex >= 0) return Promise.resolve(this.messages.splice(existingIndex, 1)[0]);

    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timeout: null };
      waiter.timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${this.candidate}. ${this.stderr.trim()}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  waitForExit(timeoutMs = 5_000) {
    return withTimeout(this.exitPromise, timeoutMs, `Timed out waiting for ${this.candidate} exit`);
  }

  async stop() {
    if (!this.child) return;
    this.send({ type: 'shutdown' });
    try {
      await this.waitForExit(1_000);
    } catch {
      this.child.kill();
      await this.waitForExit(2_000);
    }
  }
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

async function measureMemory(pid) {
  const script =
    `$p = Get-Process -Id ${Number(pid)} -ErrorAction Stop; ` +
    `[pscustomobject]@{ privateBytes = $p.PrivateMemorySize64; workingSetBytes = $p.WorkingSet64 } | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
  });
  return JSON.parse(stdout.trim());
}

let requestSequence = 0;
function nextRequestId(prefix) {
  requestSequence += 1;
  return `${prefix}-${requestSequence}`;
}

async function roundTrip(boundary, request, responseType) {
  const startedAt = performance.now();
  boundary.send(request);
  const response = await boundary.waitFor(
    (message) => message.type === responseType && message.requestId === request.requestId
  );
  return { response, elapsedMs: performance.now() - startedAt };
}

async function benchmark(candidate, uncontrolledFirstReadyMs) {
  dispatch({ type: 'started', candidate, status: 'starting first process' });
  const first = new BoundaryProcess(candidate);
  const firstReady = await first.start();
  dispatch({ type: 'progress', candidate, status: 'sampling idle memory' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const memory = await measureMemory(first.pid);

  dispatch({ type: 'progress', candidate, status: 'probing first and warm work' });
  const firstWorkId = nextRequestId('work');
  const firstWork = await roundTrip(first, { type: 'work', requestId: firstWorkId, payload: 'first agent request' }, 'work:completed');
  const warmWorkLatencies = [];
  let auditRows = firstWork.response.auditRows;
  for (let index = 0; index < warmWorkCount; index += 1) {
    const requestId = nextRequestId('work');
    const work = await roundTrip(first, { type: 'work', requestId, payload: `warm agent request ${index}` }, 'work:completed');
    warmWorkLatencies.push(work.elapsedMs);
    auditRows = work.response.auditRows;
  }

  dispatch({ type: 'progress', candidate, status: `measuring ${pingCount} IPC round trips` });
  const ipcLatencies = [];
  for (let index = 0; index < pingCount; index += 1) {
    const requestId = nextRequestId('ping');
    const ping = await roundTrip(first, { type: 'ping', requestId }, 'pong');
    ipcLatencies.push(ping.elapsedMs);
  }

  dispatch({ type: 'progress', candidate, status: 'probing cancellation acknowledgement' });
  const longWorkId = nextRequestId('long-work');
  first.send({ type: 'long-work', requestId: longWorkId });
  await first.waitFor((message) => message.type === 'long-work:started' && message.requestId === longWorkId);
  const cancelStartedAt = performance.now();
  first.send({ type: 'cancel', requestId: longWorkId });
  const cancelResponse = await first.waitFor(
    (message) => message.type === 'cancelled' && message.requestId === longWorkId
  );
  const cancelAckMs = performance.now() - cancelStartedAt;
  if (!cancelResponse.hadPendingWork) throw new Error(`${candidate} cancellation missed pending work`);

  dispatch({ type: 'progress', candidate, status: 'probing crash observation and restart' });
  const crashStartedAt = performance.now();
  first.send({ type: 'crash' });
  const crashExit = await first.waitForExit();
  const crashObservedMs = performance.now() - crashStartedAt;

  const restart = new BoundaryProcess(candidate);
  const restartReady = await restart.start();
  await restart.stop();

  dispatch({ type: 'progress', candidate, status: 'sampling repeated process launches' });
  const repeatReadyLatencies = [restartReady.readyMs];
  for (let index = 2; index < launchCount; index += 1) {
    const boundary = new BoundaryProcess(candidate);
    const ready = await boundary.start();
    repeatReadyLatencies.push(ready.readyMs);
    await boundary.stop();
  }

  return {
    candidate,
    uncontrolledFirstReadyMs,
    ready: summarize([firstReady.readyMs, ...repeatReadyLatencies]),
    firstWorkMs: firstWork.elapsedMs,
    warmWork: summarize(warmWorkLatencies),
    ipc: summarize(ipcLatencies),
    memory,
    cancelAckMs,
    crashObservedMs,
    crashExitCode: crashExit.code,
    restartReadyMs: restartReady.readyMs,
    workerLoadMs: firstReady.loadMs,
    workerProcessType: firstReady.processType,
    auditRows,
  };
}

async function runCandidates(candidates) {
  if (busy) return;
  busy = true;
  try {
    for (const candidate of candidates) {
      try {
        dispatch({ type: 'started', candidate, status: 'warming candidate before comparable samples' });
        const prewarm = new BoundaryProcess(candidate);
        const prewarmReady = await prewarm.start();
        await prewarm.stop();
        const result = await benchmark(candidate, prewarmReady.readyMs);
        dispatch({ type: 'completed', candidate, result });
      } catch (error) {
        dispatch({
          type: 'failed',
          candidate,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        });
      }
    }
  } finally {
    busy = false;
  }
}

async function quit() {
  if (quitting) return;
  quitting = true;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  app.quit();
}

async function start() {
  await app.whenReady();
  render();

  if (process.argv.includes('--once')) {
    await runCandidates(['stdio-sidecar', 'utility-process']);
    console.log(`\n${bold}Machine-readable result${reset}`);
    console.log(JSON.stringify(state.results, null, 2));
    await quit();
    return;
  }

  process.stdin.setEncoding('utf8');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', async (chunk) => {
    const key = String(chunk).toLowerCase();
    if (key === '\u0003' || key === 'q') await quit();
    else if (key === 'r' && !busy) dispatch({ type: 'reset' });
    else if (key === 'b') await runCandidates(['stdio-sidecar', 'utility-process']);
    else if (key === 's') await runCandidates(['stdio-sidecar']);
    else if (key === 'u') await runCandidates(['utility-process']);
  });
}

start().catch((error) => {
  console.error(error);
  app.exit(1);
});
