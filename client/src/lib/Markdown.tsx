import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  children: string;
  className?: string;
}

/**
 * Renders Claude's output as markdown — headings, lists, code blocks, tables,
 * emphasis. Used in the overlay's assistant bubbles and the recap view.
 */
export function Markdown({ children, className }: Props) {
  return (
    <div className={`md${className ? " " + className : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Keep code blocks readable on dark backgrounds; let CSS pick colors.
          code({ inline, className, children, ...props }: any) {
            return inline
              ? <code className="md-inline-code" {...props}>{children}</code>
              : <pre className="md-code-block"><code className={className} {...props}>{children}</code></pre>;
          },
          a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
