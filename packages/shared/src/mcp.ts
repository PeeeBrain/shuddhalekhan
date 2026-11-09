import { z } from 'zod';

export const toolApprovalPolicySchema = z.enum(['disabled', 'alwaysAsk', 'alwaysAllow']);
export type AgentToolApprovalPolicy = z.infer<typeof toolApprovalPolicySchema>;
export const DEFAULT_TOOL_POLICY: AgentToolApprovalPolicy = 'alwaysAsk';

export function makeMcpToolPolicyKey(serverId: string, toolName: string): `${string}:${string}` {
  return `${serverId}:${toolName}`;
}

export function modelToolName(serverId: string, toolName: string): string {
  return `${serverId}__${toolName}`;
}

export function parseModelToolName(name: string) {
  const separator = name.indexOf('__');
  return {
    serverId: separator > 0 ? name.slice(0, separator) : '',
    toolName: separator > 0 ? name.slice(separator + 2) : name,
  };
}
