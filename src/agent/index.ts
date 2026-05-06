import { createInterface } from 'readline';
import { logSidecar, parseElectronMessage, writeJsonLine } from './protocol';
import { runAgent } from './runtime';
import type { AppConfig } from '../types/ipc';

let config: AppConfig | null = null;
let activeAgentRunId: string | null = null;
let activeAbortController: AbortController | null = null;

function main(): void {
  writeJsonLine({
    type: 'sidecar:ready',
    protocolVersion: 1,
  });

  logSidecar('ready');

  const input = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  input.on('line', (line) => {
    try {
      handleLine(line);
    } catch (err) {
      logSidecar('failed to handle protocol line', err);
    }
  });
}

function handleLine(line: string): void {
  const message = parseElectronMessage(line);
  if (!message) {
    logSidecar('ignored unknown protocol message');
    return;
  }

  switch (message.type) {
    case 'config:update':
      config = message.config;
      logSidecar('received config update');
      break;
    case 'agent:start':
      handleAgentStart(message.agentRunId, message.transcript);
      break;
    case 'agent:cancel':
      handleAgentCancel(message.agentRunId);
      break;
    case 'approval:decision':
      logSidecar(`received approval decision ${message.decision}`);
      break;
  }
}

async function handleAgentStart(agentRunId: string, transcript: string): Promise<void> {
  const previousAgentRunId = activeAgentRunId;
  const previousAbortController = activeAbortController;

  if (previousAgentRunId && previousAbortController) {
    previousAbortController.abort();
    writeJsonLine({ type: 'agent:cancelled', agentRunId: previousAgentRunId });
  }

  activeAgentRunId = agentRunId;
  activeAbortController = new AbortController();

  const currentConfig = config;
  if (!currentConfig) {
    writeJsonLine({ type: 'agent:failed', agentRunId, error: 'No config available' });
    activeAgentRunId = null;
    activeAbortController = null;
    return;
  }

  try {
    await runAgent(agentRunId, transcript, currentConfig, activeAbortController.signal, {
      onStatus: (status) => {
        if (activeAgentRunId !== agentRunId) return;
        writeJsonLine({ type: 'agent:status', agentRunId, status });
      },
      onCompleted: (response, toolSummary) => {
        if (activeAgentRunId !== agentRunId) return;
        writeJsonLine({ type: 'agent:completed', agentRunId, response, toolSummary });
        activeAgentRunId = null;
        activeAbortController = null;
      },
      onFailed: (error) => {
        if (activeAgentRunId !== agentRunId) return;
        writeJsonLine({ type: 'agent:failed', agentRunId, error });
        activeAgentRunId = null;
        activeAbortController = null;
      },
      onCancelled: () => {
        if (activeAgentRunId !== agentRunId) return;
        writeJsonLine({ type: 'agent:cancelled', agentRunId });
        activeAgentRunId = null;
        activeAbortController = null;
      },
    });
  } catch (err) {
    if (activeAgentRunId !== agentRunId) return;
    logSidecar('unhandled agent start error', err);
    writeJsonLine({
      type: 'agent:failed',
      agentRunId,
      error: err instanceof Error ? err.message : String(err),
    });
    activeAgentRunId = null;
    activeAbortController = null;
  }
}

function handleAgentCancel(agentRunId: string): void {
  if (activeAgentRunId === agentRunId && activeAbortController) {
    activeAbortController.abort();
    activeAgentRunId = null;
    activeAbortController = null;
  }
  writeJsonLine({
    type: 'agent:cancelled',
    agentRunId,
  });
}

main();
