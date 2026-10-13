import type { ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const HEADING = 'mb-1 mt-2 text-sm font-semibold first:mt-0';
const LINK = 'text-primary underline underline-offset-2';

/**
 * Agent responses, run history, and release notes share one GFM renderer.
 * Headings stay paragraph-sized so a model's `#` can't outshout the card, and
 * images render as links so untrusted output never loads remote URLs.
 */
const components: Components = {
  p: ({ node: _node, ...props }) => <p {...props} className="my-1.5 whitespace-pre-wrap first:mt-0 last:mb-0" />,
  h1: ({ node: _node, ...props }) => <p {...props} className={HEADING} />,
  h2: ({ node: _node, ...props }) => <p {...props} className={HEADING} />,
  h3: ({ node: _node, ...props }) => <p {...props} className={HEADING} />,
  h4: ({ node: _node, ...props }) => <p {...props} className={HEADING} />,
  h5: ({ node: _node, ...props }) => <p {...props} className={HEADING} />,
  h6: ({ node: _node, ...props }) => <p {...props} className={HEADING} />,
  ul: ({ node: _node, className, ...props }) => (
    <ul {...props} className={`my-1.5 space-y-1 ${className === 'contains-task-list' ? 'list-none' : 'list-disc pl-4'}`} />
  ),
  ol: ({ node: _node, ...props }) => <ol {...props} className="my-1.5 list-decimal space-y-1 pl-4" />,
  li: ({ node: _node, ...props }) => <li {...props} className="[&>ol]:my-1 [&>ul]:my-1 [&>input]:mr-1.5 [&>input]:align-middle" />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote {...props} className="my-1.5 border-l-2 border-border pl-3 text-muted-foreground" />
  ),
  hr: () => <hr className="my-3 border-border/60" />,
  pre: ({ node: _node, ...props }) => (
    <pre
      {...props}
      className="my-2 max-w-full overflow-auto rounded-md border border-border bg-muted p-2 text-xs leading-relaxed [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-foreground"
    />
  ),
  code: ({ node: _node, className: _className, ...props }) => (
    <code {...props} className="rounded bg-muted px-1 py-px text-xs text-primary" />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="my-2 max-w-full overflow-x-auto">
      <table {...props} className="border-collapse text-xs tabular-nums" />
    </div>
  ),
  th: ({ node: _node, ...props }) => <th {...props} className="border border-border px-2 py-1 text-left font-semibold" />,
  td: ({ node: _node, ...props }) => <td {...props} className="border border-border px-2 py-1 align-top" />,
  strong: ({ node: _node, ...props }) => <strong {...props} className="font-semibold text-foreground" />,
  em: ({ node: _node, ...props }) => <em {...props} className="italic" />,
  a: ({ node: _node, ...props }) => <a {...props} className={LINK} />,
  img: ({ src, alt }) => (typeof src === 'string' && src ? <a href={src} className={LINK}>{alt || src}</a> : null),
};

const remarkPlugins = [remarkGfm];

export function renderMarkdown(markdown: string): ReactNode {
  return <Markdown remarkPlugins={remarkPlugins} components={components}>{markdown}</Markdown>;
}
