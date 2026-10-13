import { randomUUID } from 'node:crypto';
import type { AgentMemoryCommitResult, AgentMemoryUpdate } from '../shared/agent-context';
import type { ElectronToSidecarMessage, SidecarEvent } from './protocol';

export class AgentMemoryCommitter {
  private readonly pending = new Map<string, { agentRunId: string; finish: (result: AgentMemoryCommitResult) => void }>();

  constructor(private readonly send: (event: SidecarEvent) => void) {}

  request(agentRunId: string, revision: string, updates: AgentMemoryUpdate[], signal: AbortSignal): Promise<AgentMemoryCommitResult> {
    if (signal.aborted) return Promise.resolve({ saved: false, message: 'The agent run was interrupted.' });
    return new Promise(resolve => {
      const requestId = randomUUID();
      const finish = (result: AgentMemoryCommitResult) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        resolve(result);
      };
      const abort = () => finish({ saved: false, message: 'The agent run was interrupted.' });
      const timeout = setTimeout(() => finish({ saved: false, message: 'Memory save was not acknowledged.' }), 3000);
      this.pending.set(requestId, { agentRunId, finish });
      signal.addEventListener('abort', abort, { once: true });
      try { this.send({ type: 'memory:propose', agentRunId, requestId, revision, updates }); }
      catch { finish({ saved: false, message: 'Memory save could not be requested.' }); }
    });
  }

  accept(message: Extract<ElectronToSidecarMessage, { type: 'memory:commit-result' }>): void {
    const pending = this.pending.get(message.requestId);
    if (pending?.agentRunId === message.agentRunId) pending.finish(message.result);
  }
}
