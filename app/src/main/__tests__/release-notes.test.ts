import { describe, expect, it } from 'bun:test';
import { installElectronMock } from '../../test/electron-mock';

installElectronMock();

const {
  fetchReleaseNotesForVersion,
  getReleaseNotesPreview,
} = await import('../release-notes');

describe('release notes', () => {
  it('loads raw Markdown for the exact GitHub release tag', async () => {
    const fetcher = (() => Promise.resolve(new Response(JSON.stringify({
      tag_name: 'v4.6.0',
      body: '## Added\n- A change',
    })))) as typeof fetch;

    await expect(fetchReleaseNotesForVersion('4.6.0', fetcher)).resolves.toEqual({
      version: '4.6.0',
      notes: '## Added\n- A change',
    });
  });

  it('rejects mismatched tags and invalid versions without exposing feed HTML', async () => {
    const fetcher = (() => Promise.resolve(new Response(JSON.stringify({
      tag_name: 'v4.6.1',
      body: '<h2>Rendered HTML</h2>',
    })))) as typeof fetch;

    await expect(fetchReleaseNotesForVersion('4.6.0', fetcher)).resolves.toBeNull();
    await expect(fetchReleaseNotesForVersion('latest', fetcher)).resolves.toBeNull();
  });

  it('builds a short plain-text preview without link destinations', () => {
    expect(getReleaseNotesPreview([
      {
        version: '4.6.0',
        notes: [
          '### Added',
          '- First',
          '- Read the [documentation](https://example.com)',
          '- Third',
        ].join('\n'),
      },
    ], 2)).toBe('• First\n• Read the documentation');
  });
});
