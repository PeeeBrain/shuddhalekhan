import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReleaseNotes, VersionReleaseNotes } from '../types/ipc';

const RELEASE_API_ROOT =
  'https://api.github.com/repos/PeeeBrain/shuddhalekhan/releases/tags';
const MAX_RELEASE_NOTES_LENGTH = 200_000;

export function getBundledReleaseNotes(): VersionReleaseNotes | null {
  if (!app.isPackaged) return null;

  try {
    const raw = readFileSync(join(process.resourcesPath, 'release-notes.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<VersionReleaseNotes>;
    if (
      parsed.version !== app.getVersion() ||
      typeof parsed.notes !== 'string' ||
      !parsed.notes.trim()
    ) {
      return null;
    }
    return { version: parsed.version, notes: parsed.notes };
  } catch (error) {
    console.warn('Could not read bundled release notes:', error);
    return null;
  }
}

export async function fetchReleaseNotesForVersion(
  version: string,
  fetcher: typeof fetch = fetch,
): Promise<VersionReleaseNotes | null> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;

  const expectedTag = `v${version}`;
  try {
    const response = await fetcher(
      `${RELEASE_API_ROOT}/${encodeURIComponent(expectedTag)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      tag_name?: unknown;
      body?: unknown;
    };
    if (
      payload.tag_name !== expectedTag ||
      typeof payload.body !== 'string' ||
      !payload.body.trim() ||
      payload.body.length > MAX_RELEASE_NOTES_LENGTH
    ) {
      return null;
    }

    return { version, notes: payload.body.trim() };
  } catch {
    return null;
  }
}

export function getReleaseNotesPreview(
  releaseNotes: ReleaseNotes,
  maximumItems = 5,
): string {
  const items = releaseNotes
    .flatMap(({ notes }) => notes.split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'))
    .slice(0, maximumItems);

  if (items.length === 0) {
    return 'Open Settings to read what changed in this release.';
  }
  return items.map((item) => `• ${item}`).join('\n');
}
