import { describe, expect, it } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { renderMarkdown } from '../markdown';

describe('renderMarkdown', () => {
  it('renders markdown links', () => {
    render(
      <div>
        {renderMarkdown('- Fix by @user in [#164](https://github.com/PeeeBrain/shuddhalekhan/pull/164)')}
      </div>,
    );

    expect(screen.getByRole('link', { name: '#164' })).toHaveAttribute(
      'href',
      'https://github.com/PeeeBrain/shuddhalekhan/pull/164',
    );
  });

  it('linkifies bare URLs from generated release notes', () => {
    render(
      <div>
        {renderMarkdown(
          '**Full Changelog**: https://github.com/PeeeBrain/shuddhalekhan/compare/v4.5.6...v4.5.7',
        )}
      </div>,
    );

    expect(
      screen.getByRole('link', {
        name: 'https://github.com/PeeeBrain/shuddhalekhan/compare/v4.5.6...v4.5.7',
      }),
    ).toHaveAttribute('href', 'https://github.com/PeeeBrain/shuddhalekhan/compare/v4.5.6...v4.5.7');
  });

  it('keeps trailing sentence punctuation out of bare URL links', () => {
    render(<div>{renderMarkdown('See https://example.com.')}</div>);

    const link = screen.getByRole('link', { name: 'https://example.com' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link.parentElement?.textContent).toBe('See https://example.com.');
  });
});
