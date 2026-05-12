import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';

type CliOptions = {
  file: string;
  endpoint: string;
  language: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    file: '',
    endpoint: 'http://localhost:8080/inference',
    language: 'mr',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--file' && next) {
      options.file = next;
      index += 1;
    } else if (arg === '--endpoint' && next) {
      options.endpoint = next;
      index += 1;
    } else if (arg === '--language' && next) {
      options.language = next;
      index += 1;
    }
  }

  if (!options.file) {
    throw new Error('Usage: bun scripts/verify-whisper-endpoint.ts --file path/to/audio.wav [--endpoint URL] [--language mr]');
  }

  if (!existsSync(options.file)) {
    throw new Error(`Audio file does not exist: ${options.file}`);
  }

  return options;
}

async function postAudio(options: CliOptions, translate: boolean): Promise<unknown> {
  const form = new FormData();
  const audio = readFileSync(options.file);
  form.append('file', new Blob([audio], { type: 'audio/wav' }), basename(options.file));
  form.append('temperature', '0.2');
  form.append('response_format', 'json');
  form.append('translate', translate ? 'true' : 'false');
  if (options.language !== 'auto') {
    form.append('language', options.language);
  }

  const response = await fetch(options.endpoint, {
    method: 'POST',
    body: form as unknown as BodyInit,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const options = parseArgs(process.argv.slice(2));

console.log(`Endpoint: ${options.endpoint}`);
console.log(`File: ${options.file}`);
console.log(`Language: ${options.language}`);

for (const translate of [false, true]) {
  console.log(`\ntranslate=${translate}`);
  const result = await postAudio(options, translate);
  console.log(JSON.stringify(result, null, 2));
}
