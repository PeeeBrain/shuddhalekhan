import { z } from 'zod';
import { hasDictionaryControlCharacters } from '../shared/transcription-features';

export const localVocabularySchema = z.array(z.string().trim().min(1).refine(term => [...term].length <= 128)
  .refine(term => !hasDictionaryControlCharacters(term) && !/[/:]/u.test(term),
    'Local vocabulary cannot contain control characters, slashes, or colons.')).max(64);

/** SentencePiece BPE scores are negative merge ranks, in the same order as NeMo's exported token IDs. */
export function localBpeVocabulary(tokensText: string): string {
  return tokensText.split(/\r?\n/u).flatMap(line => {
    const match = /^(\S+) (\d+)$/u.exec(line);
    return match && match[1] !== '<blk>' ? [`${match[1]}\t${-Number(match[2])}`] : [];
  }).join('\n') + '\n';
}
