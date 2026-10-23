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

  it('turns images into links so untrusted output never loads remote URLs', () => {
    const { container } = render(<div>{renderMarkdown('![chart](https://example.com/x.png)')}</div>);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'chart' })).toHaveAttribute('href', 'https://example.com/x.png');
  });

  it('keeps links with stripped unsafe schemes as plain text', () => {
    const { container } = render(<div>{renderMarkdown('[unsafe](javascript:alert%281%29) and [empty]()')}</div>);

    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('unsafe and empty');
  });

  it('renders a linked image as the link label instead of nesting anchors', () => {
    const { container } = render(
      <div>{renderMarkdown('[![badge](https://example.com/badge.svg)](https://example.com/project)')}</div>,
    );

    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://example.com/project');
    expect(links[0]).toHaveTextContent('badge');
  });

  it('renders soft and hard line breaks as exactly one break each', () => {
    const { container } = render(<div>{renderMarkdown('soft\nbreak\n\nhard  \nbreak\\\nend')}</div>);

    const [soft, hard] = container.querySelectorAll('p');
    expect(soft?.querySelectorAll('br')).toHaveLength(1);
    expect(hard?.querySelectorAll('br')).toHaveLength(2);
    // The newline text react-markdown leaves after each <br> must stay collapsible.
    expect(hard?.className).not.toContain('pre');
  });

});
