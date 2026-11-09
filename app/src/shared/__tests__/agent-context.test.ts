import { expect, it } from 'bun:test';
import { memoryFactSchema } from '../agent-context';

// Saved memory is sent with every later model request, so credentials must never get in.
it('rejects credentials in memory facts, quoted or not', () => {
  for (const fact of ['Use Bearer "eyJhbGciOiJIUzI1NiJ9"', 'Use Bearer abc123', 'My key is sk-abcdefgh12345', 'password: hunter2']) {
    expect(memoryFactSchema.safeParse(fact).success).toBe(false);
  }
  expect(memoryFactSchema.safeParse('Prefers short answers in British English').success).toBe(true);
});
