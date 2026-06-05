import { Suspense, lazy } from "react";

// The Prism highlighter pulls in ~1.6MB of language grammars. We load it ONLY
// when a code block actually renders (dynamic import → its own chunk), so the
// initial app download stays light for users on distant/slow connections.
// Until the chunk arrives, code shows as plain monospace (the <pre> fallback),
// then upgrades to colored — no blocking, no upfront cost.
const Highlighter = lazy(async () => {
  const [{ Prism }, { vscDarkPlus }] = await Promise.all([
    import("react-syntax-highlighter"),
    import("react-syntax-highlighter/dist/esm/styles/prism"),
  ]);
  function Inner({ code, lang }: { code: string; lang?: string }) {
    return (
      <Prism
        language={lang ?? "text"}
        style={vscDarkPlus}
        PreTag="pre"
        CodeTag="code"
        customStyle={{ margin: "8px 0", borderRadius: 8, padding: "10px 12px", fontSize: "0.9em", background: "rgba(0,0,0,0.42)" }}
        codeTagProps={{ style: { fontFamily: 'ui-monospace, "Cascadia Code", Menlo, monospace' } }}
      >
        {code}
      </Prism>
    );
  }
  return { default: Inner };
});

/** Plain fallback shown instantly (and while the highlighter chunk loads). */
function PlainCode({ code }: { code: string }) {
  return <pre className="md-code-block"><code>{code}</code></pre>;
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  return (
    <Suspense fallback={<PlainCode code={code} />}>
      <Highlighter code={code} lang={lang} />
    </Suspense>
  );
}
