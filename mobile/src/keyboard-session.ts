import { z } from 'zod';

/** Low-frequency native lifecycle events. Mic levels stay on the keyboard socket. */
export const keyboardSessionSchema = z.object({
  endsAt: z.number().int().nonnegative().safe(),
  phase: z.enum(['idle', 'recording', 'transcribing', 'done', 'failed', 'cancelled']),
  agentReady: z.boolean(),
  requestId: z.string().trim().min(1).max(128).optional(),
  mode: z.enum(['dictate', 'agent']).optional(),
  text: z.string().max(200_000).optional(),
  error: z.string().max(500).optional(),
}).refine(event => (event.requestId === undefined) === (event.mode === undefined));
export type KeyboardSessionEvent = z.infer<typeof keyboardSessionSchema>;
