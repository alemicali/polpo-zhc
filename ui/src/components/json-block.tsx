/** Lightweight JSON syntax colorizer — no external deps */
export function JsonBlock({ data, className }: { data: unknown; className?: string }) {
  const json = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  // Tokenize JSON into colored spans
  const parts = json.split(/("(?:\\.|[^"\\])*"(?:\s*:)?|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g);
  return (
    <pre className={className ?? "text-micro leading-relaxed font-mono bg-muted/20 rounded-lg px-4 py-3 whitespace-pre-wrap max-h-56 overflow-auto border border-border/20"}>
      <code>
        {parts.map((part, i) => {
          if (!part) return null;
          // String keys (ending with :)
          if (/^".*":\s*$/.test(part))
            return <span key={i} className="text-chart-1">{part}</span>;
          // String values
          if (/^"/.test(part))
            return <span key={i} className="text-chart-3">{part}</span>;
          // Booleans
          if (part === "true" || part === "false")
            return <span key={i} className="text-chart-5">{part}</span>;
          // Null
          if (part === "null")
            return <span key={i} className="text-muted-foreground">{part}</span>;
          // Numbers
          if (/^-?\d/.test(part))
            return <span key={i} className="text-chart-4">{part}</span>;
          // Punctuation / whitespace
          return <span key={i} className="text-muted-foreground/60">{part}</span>;
        })}
      </code>
    </pre>
  );
}
