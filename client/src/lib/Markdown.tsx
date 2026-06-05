import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

interface Props {
  children: string;
  className?: string;
}

/**
 * Renders model output as markdown. Code blocks are syntax-highlighted via
 * Prism (vscode dark+ theme) when a language is specified. Used in the
 * overlay's assistant bubbles and the recap view.
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
            // Block code: try to extract the language from ``` lang fence.
            const text = String(children ?? "").replace(/\n$/, "");
            const m = /language-([\w+-]+)/.exec(className ?? "");
            const lang = m ? m[1] : undefined;
            return (
              <SyntaxHighlighter
                language={lang ?? "text"}
                style={vscDarkPlus}
                PreTag="pre"
                CodeTag="code"
                customStyle={{
                  margin: "8px 0",
                  borderRadius: 8,
                  padding: "10px 12px",
                  fontSize: "0.9em",
                  background: "rgba(0,0,0,0.42)",
                  // Match the existing .md pre look in styles.css so it blends
                  // with the rest of the bubble even when highlighter is off.
                }}
                codeTagProps={{ style: { fontFamily: 'ui-monospace, "Cascadia Code", Menlo, monospace' } }}
              >
                {text}
              </SyntaxHighlighter>
            );
          },
          a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
