import { createInterface } from 'readline';

const ignoreEof = process.argv.includes('--ignore-stdin-eof');
const floodStderr = process.argv.includes('--flood-stderr');

if (floodStderr) {
  const secret = process.env.FIXTURE_TOKEN ?? '';
  const chunk = `noise ${secret} noise\n`;
  let written = 0;
  const pump = () => {
    while (written < 200_000) {
      written += chunk.length;
      process.stderr.write(chunk);
    }
  };
  pump();
}

process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, result: { ready: true } })}\n`);

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line) as { id?: unknown; method?: string };
    if (message.method === 'getEnv') {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            declared: process.env.FIXTURE_TOKEN ?? null,
            home: process.env.HOME ?? null,
            userProfile: process.env.USERPROFILE ?? null,
          },
        })}\n`
      );
      return;
    }
    if (message.method === 'emitMalformed') {
      process.stdout.write('not-json-at-all\n');
      return;
    }
    if (message.method === 'emitSecretMalformed') {
      process.stdout.write(`not-json ${process.env.FIXTURE_TOKEN ?? ''}\n`);
      return;
    }
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echoed: message.method } })}\n`
    );
  } catch {
    process.stdout.write('not-json-at-all\n');
  }
});

if (!ignoreEof) {
  input.on('close', () => process.exit(0));
}

setInterval(() => undefined, 60_000);
