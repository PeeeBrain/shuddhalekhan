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

  it('renders thematic breaks as rules instead of literal text', () => {
    const { container } = render(<div>{renderMarkdown('Intro.\n***\n- item\n\n* * *\nOutro.')}</div>);

    expect(container.querySelectorAll('hr')).toHaveLength(2);
    expect(container.textContent).not.toContain('*');
    expect(screen.getByRole('listitem')).toHaveTextContent('item');
  });

  it('keeps one numbered list across blank lines and continuation lines', () => {
    const { container } = render(<div>{renderMarkdown('1. **First**\n   detail\n\n2. Second\n\n3. Third')}</div>);

    expect(container.querySelectorAll('ol')).toHaveLength(1);
    expect(container.querySelectorAll('li')).toHaveLength(3);
    expect(container.querySelector('li')).toHaveTextContent('First detail');
  });

  it('nests lists and inline markup the way models write them', () => {
    const { container } = render(<div>{renderMarkdown('- **Run `bun test` *now***\n  - child\n\n2 * 3 * 4')}</div>);

    expect(container.querySelector('ul ul li')).toHaveTextContent('child');
    expect(container.querySelector('strong code')).toHaveTextContent('bun test');
    expect(container.querySelector('strong em')).toHaveTextContent('now');
    expect(container.textContent).toContain('2 * 3 * 4');
  });

  it('renders GFM tables', () => {
    render(<div>{renderMarkdown('| Name | Value |\n|---|---|\n| a | 1 |')}</div>);

    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '1' })).toBeInTheDocument();
  });

  it('turns images into links so untrusted output never loads remote URLs', () => {
    const { container } = render(<div>{renderMarkdown('![chart](https://example.com/x.png)')}</div>);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'chart' })).toHaveAttribute('href', 'https://example.com/x.png');
  });

  it('keeps trailing sentence punctuation out of bare URL links', () => {
    render(<div>{renderMarkdown('See https://example.com.')}</div>);

    const link = screen.getByRole('link', { name: 'https://example.com' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link.parentElement?.textContent).toBe('See https://example.com.');
  });
});
