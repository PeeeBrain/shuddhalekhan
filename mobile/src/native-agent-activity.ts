import { requireOptionalNativeModule } from 'expo';
import { recoveredAgentRunSchema, startedAgentRunSchema, stoppedAgentRunSchema, type AgentActivityPort, type AgentActivityUpdate } from './agent-activity';

type NativeAgentActivity = {
  start(maximumSteps: number): Promise<unknown>;
  resume(runId: string): Promise<void>;
  prepareApproval(update: Extract<AgentActivityUpdate, { phase: 'awaitingApproval' }>): Promise<void>;
  canContinueInBackground(runId: string): Promise<boolean>;
  update(update: AgentActivityUpdate): Promise<void>;
  recover(): Promise<unknown>;
  clear(runId: string): Promise<void>;
  addListener(event: 'onAgentRunStopped', listener: (event: unknown) => void): { remove(): void };
};

const native = requireOptionalNativeModule<NativeAgentActivity>('ShuddhalekhanAgentActivity');

export const agentActivity: AgentActivityPort | undefined = native ? {
  async start(maximumSteps) { return startedAgentRunSchema.parse(await native.start(maximumSteps)); },
  resume: runId => native.resume(runId),
  prepareApproval: update => native.prepareApproval(update),
  canContinueInBackground: runId => native.canContinueInBackground(runId),
  update: update => native.update(update),
  async recover() {
    const result = await native.recover();
    return result === null ? null : recoveredAgentRunSchema.parse(result);
  },
  clear: runId => native.clear(runId),
} : undefined;

export function onAgentRunStopped(listener: (runId: string) => void): { remove(): void } | undefined {
  return native?.addListener('onAgentRunStopped', value => {
    const result = stoppedAgentRunSchema.safeParse(value);
    if (result.success) listener(result.data.runId);
  });
}
