import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css"; // syntax-highlight theme for code blocks

interface Props {
  children: string;
  className?: string;
}

/**
 * Renders Claude's output as markdown — headings, lists, code blocks, tables,
 * emphasis. Used in the overlay's assistant bubbles and the recap view.
 *
 * Code blocks get real syntax highlighting via rehype-highlight (highlight.js),
 * so coding-question answers read like an IDE. Inline code stays plain.
 */
export function Markdown({ children, className }: Props) {
  return (
    <div className={`md${className ? " " + className : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          // Inline code keeps the simple chip style; block code (inside <pre>)
          // is left to rehype-highlight, which adds hljs token classes.
          code({ inline, className, children, ...props }: any) {
            return inline
              ? <code className="md-inline-code" {...props}>{children}</code>
              : <code className={className} {...props}>{children}</code>;
          },
          a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
