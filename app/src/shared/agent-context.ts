import { z } from 'zod';

export const MEMORY_FACT_LIMIT = 50;
export const MEMORY_BYTE_LIMIT = 8192;
export const memoryFactSchema = z.string().trim().min(1).max(512)
  .refine(text => !/[\r\n]/.test(text), 'Each fact must fit on one line.')
  .refine(text => !/\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|(?:password|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S+)/i.test(text), 'Credentials must not be stored in memory.');
export const memoryFactsSchema = z.array(memoryFactSchema).max(MEMORY_FACT_LIMIT);
export const memoryUpdatesSchema = z.array(z.object({ previous: z.string().max(512).nullable(), text: memoryFactSchema })).max(10);
export type AgentMemoryUpdate = z.infer<typeof memoryUpdatesSchema>[number];

export interface AgentSkillSummary {
  name: string;
  description: string;
  enabled: boolean;
  error: string | null;
}

export interface AgentSkillDocument {
  name: string;
  content: string;
}

export interface AgentSkillImport {
  token: string;
  name: string;
  description: string;
}

export interface AgentMemorySnapshot {
  revision: string;
  markdown: string;
  facts: Array<{ id: string; text: string }>;
  status: string | null;
  error: string | null;
}

export interface AgentRunContext {
  skillsDirectory: string;
  memory: Pick<AgentMemorySnapshot, 'revision' | 'markdown'> | null;
}

export type AgentMemoryCommitResult =
  | { saved: true; message?: string }
  | { saved: false; message: string };
