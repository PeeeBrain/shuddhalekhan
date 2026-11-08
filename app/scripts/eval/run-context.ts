import { createHash } from 'crypto';
import { closeSync, openSync, readSync } from 'fs';
import { join, resolve } from 'path';

/** Hash in chunks so model provenance does not inflate the eval's peak memory. */
export function modelIdentity(directory: string, files: readonly string[]) {
  const buffer = Buffer.alloc(64 * 1024);
  return {
    directory: resolve(directory),
    files: Object.fromEntries(files.map((file) => {
      const hash = createHash('sha256');
      const fd = openSync(join(directory, file), 'r');
      try {
        let bytes: number;
        while ((bytes = readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, bytes));
      } finally {
        closeSync(fd);
      }
      return [file, hash.digest('hex')];
    })),
  };
}

export function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
