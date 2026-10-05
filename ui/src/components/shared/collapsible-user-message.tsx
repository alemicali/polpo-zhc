import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

export const USER_MESSAGE_MAX_HEIGHT = 240;

/** Clip only the displayed text: the original message and copy action stay intact. */
export function CollapsibleUserMessage({ text, children }: { text: string; children: ReactNode }) {
  const contentId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => setOverflowing(content.scrollHeight > USER_MESSAGE_MAX_HEIGHT);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div className="min-w-0">
      <div id={contentId} className="overflow-hidden" style={{ maxHeight: expanded ? undefined : USER_MESSAGE_MAX_HEIGHT }}>
        <div ref={contentRef} className="text-sm leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {children}
        </div>
      </div>
      {overflowing && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded(value => !value)}
          className="mt-2 flex min-h-8 w-full items-center justify-center gap-1.5 border-t border-current/20 pt-2 text-xs font-medium text-inherit hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          {expanded ? "Riduci" : "Mostra tutto"}
          {expanded ? <ChevronUp aria-hidden="true" className="size-3.5" /> : <ChevronDown aria-hidden="true" className="size-3.5" />}
        </button>
      )}
    </div>
  );
}
