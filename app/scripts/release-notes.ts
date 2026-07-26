export interface PreparedReleaseNotes {
  version: string;
  notes: string;
}

interface MarkdownHeading {
  level: number;
  title: string;
}

export function extractUnreleasedNotes(changelog: string): string {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  let start = -1;
  let end = lines.length;

  for (let index = 0; index < lines.length; index++) {
    const heading = parseHeading(lines[index] ?? '');
    if (!heading || heading.level !== 2) continue;

    if (start === -1 && heading.title.toLowerCase() === 'unreleased') {
      start = index + 1;
      continue;
    }

    if (start !== -1) {
      end = index;
      break;
    }
  }

  if (start === -1) {
    throw new Error('CHANGELOG.md must contain a level-two "Unreleased" heading.');
  }

  const notes = lines.slice(start, end).join('\n').trim();
  if (!notes) {
    throw new Error('The Unreleased changelog section is empty.');
  }
  return `${notes}\n`;
}

export function prepareReleaseNotes(
  changelog: string,
  version: string,
): PreparedReleaseNotes {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid semantic version: ${version}`);
  }

  return {
    version,
    notes: extractUnreleasedNotes(changelog),
  };
}

function parseHeading(line: string): MarkdownHeading | null {
  const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
  if (!match) return null;

  return {
    level: match[1]?.length ?? 0,
    title: match[2]?.trim() ?? '',
  };
}
