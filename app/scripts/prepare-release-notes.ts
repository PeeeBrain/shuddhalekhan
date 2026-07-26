import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { prepareReleaseNotes } from './release-notes';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    version: { type: 'string' },
    changelog: { type: 'string', default: 'CHANGELOG.md' },
    'markdown-output': { type: 'string' },
    'json-output': { type: 'string' },
  },
  strict: true,
});

if (!values.version || !values['markdown-output'] || !values['json-output']) {
  throw new Error(
    'Usage: prepare-release-notes --version X.Y.Z --markdown-output <path> --json-output <path>',
  );
}

const changelogPath = resolve(values.changelog);
const markdownOutputPath = resolve(values['markdown-output']);
const jsonOutputPath = resolve(values['json-output']);
const changelog = await readFile(changelogPath, 'utf8');
const releaseNotes = prepareReleaseNotes(changelog, values.version);

await Promise.all([
  mkdir(dirname(markdownOutputPath), { recursive: true }),
  mkdir(dirname(jsonOutputPath), { recursive: true }),
]);
await Promise.all([
  writeFile(markdownOutputPath, releaseNotes.notes, 'utf8'),
  writeFile(jsonOutputPath, `${JSON.stringify(releaseNotes, null, 2)}\n`, 'utf8'),
]);

console.log(`Prepared release notes for Shuddhalekhan ${releaseNotes.version}.`);
