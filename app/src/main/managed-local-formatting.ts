/** Restore prose formatting without replacing words, existing sentence punctuation, or protected casing. */
export function formatLocalText(text: string, addPunctuation: (text: string) => string, dictionary: readonly string[] = []): string {
  for (const term of [...dictionary].sort((a, b) => b.length - a.length)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'), () => term);
  }
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
  if (!words.length || /\P{ASCII}/u.test(text)) return text;
  // Native Parakeet punctuation already carries acoustic context; do not punctuate it twice.
  const prose = text.replace(/https?:\/\/\S+|\S+@\S+|\d+(?:\.\d+)+/gu, '');
  if (/[.!?]/u.test(prose)) return text;
  const formatted = addPunctuation(text);
  const resultWords = [...formatted.matchAll(/[\p{L}\p{N}]+/gu)];
  if (words.length !== resultWords.length || words.some((word, i) => word[0].toLowerCase() !== resultWords[i][0].toLowerCase())) return text;
  const protectedRanges = [...text.matchAll(/https?:\/\/\S+|\S+@\S+|\S*[\\/+=_]\S*/gu)];
  let index = 0;
  return formatted.replace(/[\p{L}\p{N}]+/gu, replacement => {
    const original = words[index++];
    const protectedWord = /[A-Z]/u.test(original[0]) || protectedRanges.some(range =>
      original.index >= range.index && original.index < range.index + range[0].length);
    return protectedWord ? original[0] : replacement;
  });
}
