/**
 * A small SQL editor: a plain textarea over a highlighted copy of its text (keywords, strings,
 * numbers, comments, functions) in the look's colours. No editor library: the text stays a
 * textarea (native undo, IME, screen readers); Ctrl/⌘+Enter runs, Tab indents.
 */
import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { highlightSql } from "./sql-highlight";

export function SqlEditor({ value, onChange, onRun, ariaLabel = "SQL", className, minRows = 6 }: {
  value: string;
  onChange: (value: string) => void;
  onRun?: () => void;
  ariaLabel?: string;
  className?: string;
  minRows?: number;
}) {
  const mirror = useRef<HTMLPreElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onRun?.(); return; }
    if (event.key === "Tab" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      const target = event.currentTarget;
      const { selectionStart: start, selectionEnd: end } = target;
      onChange(`${value.slice(0, start)}  ${value.slice(end)}`);
      requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + 2; });
    }
  };
  const tokens = highlightSql(value);
  const shared = "m-0 whitespace-pre-wrap break-words border-0 p-3 font-mono text-xs leading-relaxed";
  return (
    <div className={cn("relative overflow-hidden rounded-card border border-input bg-background focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50", className)}>
      <pre ref={mirror} aria-hidden="true" className={cn(shared, "pointer-events-none absolute inset-0 overflow-hidden text-foreground")}>
        {tokens.map((token, index) => <span key={index} className={TOKEN_CLASS[token.type]}>{token.text}</span>)}
        {/* keeps a trailing newline's line visible */}
        {"\n"}
      </pre>
      <textarea
        aria-label={ariaLabel}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        rows={Math.max(minRows, value.split("\n").length + 1)}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(event) => { if (mirror.current) { mirror.current.scrollTop = event.currentTarget.scrollTop; mirror.current.scrollLeft = event.currentTarget.scrollLeft; } }}
        className={cn(shared, "relative block max-h-[50vh] w-full resize-y bg-transparent text-transparent caret-foreground outline-none selection:bg-primary/25")}
      />
    </div>
  );
}

const TOKEN_CLASS: Record<string, string> = {
  keyword: "font-semibold text-primary",
  function: "text-info",
  string: "text-success",
  number: "text-warning",
  comment: "italic text-muted-foreground",
  operator: "text-muted-foreground",
  identifier: "",
  quoted: "text-foreground",
  plain: "",
};
