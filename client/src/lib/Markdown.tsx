import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

interface Props {
  children: string;
  className?: string;
}

/**
 * Renders model output as markdown. Code blocks are syntax-highlighted via a
 * LAZY-loaded Prism highlighter (see CodeBlock) so the ~1.6MB grammar bundle
 * never weighs down the initial client load — it fetches on demand the first
 * time a code block appears.
 */
export function Markdown({ children, className }: Props) {
  return (
    <div className={`md${className ? " " + className : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          code({ inline, className, children, ...props }: any) {
            if (inline) {
              return <code className="md-inline-code" {...props}>{children}</code>;
            }
            const text = String(children ?? "").replace(/\n$/, "");
            const m = /language-([\w+-]+)/.exec(className ?? "");
            return <CodeBlock code={text} lang={m ? m[1] : undefined} />;
          },
          a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
