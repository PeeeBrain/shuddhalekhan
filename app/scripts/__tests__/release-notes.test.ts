import { describe, expect, it } from 'bun:test';
import { extractUnreleasedNotes, prepareReleaseNotes } from '../release-notes';

describe('release notes preparation', () => {
  it('extracts only the structurally bounded Unreleased section', () => {
    const changelog = [
      '# Changelog',
      '',
      '## Unreleased',
      '',
      '### Recording',
      '- Added a shortcut.',
      '',
      '## v1.2.3',
      '- Older change.',
      '',
    ].join('\n');

    expect(extractUnreleasedNotes(changelog)).toBe(
      '### Recording\n- Added a shortcut.\n',
    );
  });

  it('does not confuse lower-level headings for release boundaries', () => {
    const changelog = [
      '## Unreleased',
      '### Added',
      '- First',
      '### Fixed',
      '- Second',
      '## v1.0.0',
    ].join('\n');

    expect(extractUnreleasedNotes(changelog)).toContain('### Fixed\n- Second');
  });

  it('rejects missing or empty Unreleased sections', () => {
    expect(() => extractUnreleasedNotes('## v1.0.0\n- Existing')).toThrow(
      'must contain a level-two "Unreleased" heading',
    );
    expect(() => extractUnreleasedNotes('## Unreleased\n\n## v1.0.0')).toThrow(
      'Unreleased changelog section is empty',
    );
  });

  it('stamps notes with an explicitly supplied semantic version', () => {
    expect(prepareReleaseNotes('## Unreleased\n- Added notes', '4.6.0')).toEqual({
      version: '4.6.0',
      notes: '- Added notes\n',
    });
    expect(() =>
      prepareReleaseNotes('## Unreleased\n- Added notes', 'next'),
    ).toThrow('Invalid semantic version');
  });
});
