import { readFileSync } from 'node:fs'

const version = process.argv[2]

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Usage: bun scripts/extract-release-notes.ts <semver-version>')
}

const lines = readFileSync('CHANGELOG.md', 'utf8').split(/\r?\n/)
const heading = `## v${version}`
const start = lines.findIndex(
  (line) => line === heading || line.startsWith(`${heading} - `),
)

if (start === -1) {
  throw new Error(`CHANGELOG.md has no section for v${version}`)
}

const end = lines.findIndex(
  (line, index) => index > start && /^## v\d+\.\d+\.\d+(?:\s|$)/.test(line),
)
const releaseNotes = lines
  .slice(start, end === -1 ? undefined : end)
  .join('\n')
  .replace(/\n---\s*$/, '')
  .trim()

if (!releaseNotes) {
  throw new Error(`CHANGELOG.md section for v${version} is empty`)
}

process.stdout.write(`${releaseNotes}\n`)
