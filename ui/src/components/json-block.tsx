/** Lightweight JSON syntax colorizer — no external deps */
export function JsonBlock({ data, className }: { data: unknown; className?: string }) {
  const json = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  // Tokenize JSON into colored spans
  const parts = json.split(/("(?:\\.|[^"\\])*"(?:\s*:)?|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g);
  return (
    <pre className={className ?? "text-[10px] leading-relaxed font-mono bg-muted/20 rounded-lg px-4 py-3 whitespace-pre-wrap max-h-56 overflow-auto border border-border/20"}>
      <code>
        {parts.map((part, i) => {
          if (!part) return null;
          // String keys (ending with :)
          if (/^".*":\s*$/.test(part))
            return <span key={i} className="text-[oklch(0.75_0.15_200)]">{part}</span>;
          // String values
          if (/^"/.test(part))
            return <span key={i} className="text-[oklch(0.78_0.12_140)]">{part}</span>;
          // Booleans
          if (part === "true" || part === "false")
            return <span key={i} className="text-[oklch(0.75_0.18_310)]">{part}</span>;
          // Null
          if (part === "null")
            return <span key={i} className="text-[oklch(0.55_0.05_260)]">{part}</span>;
          // Numbers
          if (/^-?\d/.test(part))
            return <span key={i} className="text-[oklch(0.8_0.16_70)]">{part}</span>;
          // Punctuation / whitespace
          return <span key={i} className="text-muted-foreground/60">{part}</span>;
        })}
      </code>
    </pre>
  );
}
