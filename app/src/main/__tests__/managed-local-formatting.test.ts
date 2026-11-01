import { describe, expect, it, mock } from 'bun:test';
import { formatLocalText } from '../managed-local-formatting';

describe('local formatting safeguards', () => {
  it('keeps recognized words and protected spelling while applying predicted case and punctuation', () => {
    expect(formatLocalText('use TypeScript and openai for shuddhalekhan',
      () => 'Use TYPESCRIPT and OPENAI for SHUDDHALEKHAN.', ['OpenAI', 'Shuddhalekhan']))
      .toBe('Use TypeScript and OpenAI for Shuddhalekhan.');
    expect(formatLocalText('go to https://example.com', () => 'Go to HTTPS://EXAMPLE.COM.'))
      .toBe('Go to https://example.com.');
    expect(formatLocalText('send the report', () => 'Send a longer report.')).toBe('send the report');
    expect(formatLocalText('Use openai. It works.', () => 'Unwanted rewrite.', ['OpenAI'])).toBe('Use OpenAI. It works.');
  });

  it('does not rewrite native sentence punctuation or non-English text', () => {
    const model = mock(() => 'Unwanted rewrite.');
    for (const text of ['Already formatted. Keep this.', 'Bonjour à tous', '']) {
      expect(formatLocalText(text, model)).toBe(text);
    }
    expect(model).not.toHaveBeenCalled();
  });
});
