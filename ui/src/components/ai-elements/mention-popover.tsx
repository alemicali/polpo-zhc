import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import { User, ListChecks, Target } from "lucide-react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AgentConfig, Task, Mission } from "@lumea-labs/polpo-react";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** All mentions use @ as trigger — categories are visual only in the menu */
type MentionCategory = "agent" | "task" | "mission";

interface TriggerState {
  isOpen: boolean;
  query: string;
  triggerIndex: number;
}

interface MentionItem {
  id: string;
  /** Display text shown in the menu and inserted into the textarea */
  label: string;
  /** Value sent to the server (e.g. task ID, mission ID). Falls back to label. */
  value: string;
  secondary?: string;
  badge?: string;
  icon: ReactNode;
  category: MentionCategory;
}

/**
 * Tracks one inserted mention: the display text shown in the textarea
 * and the wire value to substitute at submit time.
 */
export interface InsertedMention {
  /** The full display text in the textarea, e.g. `@Fix auth flow` or `@"my agent"` */
  displayText: string;
  /** The wire text to send to the server, e.g. `@task_abc123` or `@alice` */
  wireText: string;
}

export interface MentionPopoverHandle {
  handleTextareaKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  handleInput: () => void;
  /**
   * Resolve a display-text message into a wire message.
   * Replaces all display mentions with their wire equivalents.
   */
  resolveMessage: (displayText: string) => string;
}

export interface MentionPopoverProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  agents: AgentConfig[];
  tasks: Task[];
  missions: Mission[];
  children: ReactNode;
}

// ────────────────────────────────────────────────────────────────────────────
// Hook: useMentionTrigger
// ────────────────────────────────────────────────────────────────────────────

function useMentionTrigger(textareaRef: RefObject<HTMLTextAreaElement | null>) {
  const [state, setState] = useState<TriggerState>({
    isOpen: false,
    query: "",
    triggerIndex: -1,
  });

  const close = useCallback(() => {
    setState({ isOpen: false, query: "", triggerIndex: -1 });
  }, []);

  const handleInput = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const { value, selectionStart } = textarea;
    if (selectionStart == null) {
      close();
      return;
    }

    // Scan backwards from cursor looking for @
    let i = selectionStart - 1;
    while (i >= 0) {
      const ch = value[i];
      if (ch === " " || ch === "\n") {
        close();
        return;
      }
      if (ch === "@") {
        if (i === 0 || value[i - 1] === " " || value[i - 1] === "\n") {
          const query = value.slice(i + 1, selectionStart);
          setState({ isOpen: true, query, triggerIndex: i });
          return;
        }
        close();
        return;
      }
      i--;
    }
    close();
  }, [textareaRef, close]);

  return { ...state, close, handleInput };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Format a name as @name or @"name with spaces" */
function formatMention(name: string): string {
  return /[\s]/.test(name) ? `@"${name}"` : `@${name}`;
}

/**
 * Parse text and split into segments — plain text and @mentions.
 * Matches: @word or @"quoted text"
 */
const MENTION_RE = /(@(?:"[^"]+"|[^\s@]+))/g;

interface TextSegment {
  text: string;
  isMention: boolean;
}

function parseSegments(value: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;
  for (const match of value.matchAll(MENTION_RE)) {
    const idx = match.index!;
    if (idx > lastIndex) {
      segments.push({ text: value.slice(lastIndex, idx), isMention: false });
    }
    segments.push({ text: match[0], isMention: true });
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < value.length) {
    segments.push({ text: value.slice(lastIndex), isMention: false });
  }
  return segments;
}

/** Set textarea value using the native setter pattern (uncontrolled input) */
function setNativeValue(textarea: HTMLTextAreaElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  nativeSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Render text with @mentions highlighted as colored spans.
 * Used in rendered chat messages — not in the prompt input.
 */
export function MentionText({
  text,
  className,
  variant = "default",
}: {
  text: string;
  className?: string;
  /** "default" = blue on neutral bg, "inverted" = light on dark bg (user bubble) */
  variant?: "default" | "inverted";
}) {
  const segments = parseSegments(text);
  if (!segments.some(s => s.isMention)) {
    return <>{text}</>;
  }
  const mentionClass =
    variant === "inverted"
      ? "text-blue-200 dark:text-blue-300 font-semibold"
      : "text-blue-600 dark:text-blue-400 font-semibold";
  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.isMention ? (
          <span key={i} className={mentionClass}>{seg.text}</span>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Component: MentionPopover
// ────────────────────────────────────────────────────────────────────────────

export const MentionPopover = forwardRef<
  MentionPopoverHandle,
  MentionPopoverProps
>(function MentionPopover(
  { textareaRef, agents, tasks, missions, children },
  ref,
) {
  const { isOpen, query, triggerIndex, close, handleInput } =
    useMentionTrigger(textareaRef);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * Map of display text → wire text for all inserted mentions.
   * Display text = what the user sees (label).
   * Wire text = what gets sent to the server (ID for tasks/missions, name for agents).
   */
  const mentionsMapRef = useRef<Map<string, string>>(new Map());

  // Build structured list: agents → tasks → missions, all triggered by @
  const items = useMemo<MentionItem[]>(() => {
    const lowerQ = query.toLowerCase();
    const result: MentionItem[] = [];

    for (const a of agents) {
      if (lowerQ && !a.name.toLowerCase().includes(lowerQ)) continue;
      result.push({
        id: `agent:${a.name}`,
        label: a.name,
        value: a.name, // agents: name IS the ID
        secondary: a.role,
        icon: <User className="size-4 shrink-0 text-blue-500" />,
        category: "agent",
      });
    }

    for (const t of tasks) {
      const matchText = `${t.title} ${t.id}`.toLowerCase();
      if (lowerQ && !matchText.includes(lowerQ)) continue;
      result.push({
        id: `task:${t.id}`,
        label: t.title,   // display: task title
        value: t.id,       // wire: task ID
        secondary: t.id,
        badge: t.status,
        icon: <ListChecks className="size-4 shrink-0 text-amber-500" />,
        category: "task",
      });
    }

    for (const m of missions) {
      if (lowerQ && !m.name.toLowerCase().includes(lowerQ)) continue;
      result.push({
        id: `mission:${m.id}`,
        label: m.name,    // display: mission name
        value: m.id,       // wire: mission ID
        badge: m.status,
        icon: <Target className="size-4 shrink-0 text-emerald-500" />,
        category: "mission",
      });
    }

    return result;
  }, [query, agents, tasks, missions]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-mention-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const insertMention = useCallback(
    (item: MentionItem) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const value = textarea.value;
      const cursorPos = textarea.selectionStart ?? value.length;

      // Display text: always use label (human-readable)
      const displayMention = formatMention(item.label);
      // Wire text: use value (ID for tasks/missions, name for agents)
      const wireMention = formatMention(item.value);

      // Track the mapping for submit-time resolution
      if (displayMention !== wireMention) {
        mentionsMapRef.current.set(displayMention, wireMention);
      }

      const mention = displayMention + " ";
      const before = value.slice(0, triggerIndex);
      const after = value.slice(cursorPos);
      const newValue = before + mention + after;

      setNativeValue(textarea, newValue);

      const newCursor = before.length + mention.length;
      textarea.setSelectionRange(newCursor, newCursor);
      textarea.focus();

      close();
    },
    [textareaRef, triggerIndex, close],
  );

  /**
   * Resolve display text → wire text for all tracked mentions.
   * Called at submit time by the parent component.
   */
  const resolveMessage = useCallback(
    (displayText: string): string => {
      let resolved = displayText;
      for (const [display, wire] of mentionsMapRef.current) {
        // Replace all occurrences of the display mention with the wire mention
        while (resolved.includes(display)) {
          resolved = resolved.replace(display, wire);
        }
      }
      // Clear the map after resolution (message sent, fresh state)
      mentionsMapRef.current.clear();
      return resolved;
    },
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      handleTextareaKeyDown: (e) => {
        if (!isOpen || items.length === 0) return;

        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % items.length);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + items.length) % items.length);
        } else if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          insertMention(items[selectedIndex]);
        } else if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      },
      handleInput,
      resolveMessage,
    }),
    [isOpen, items, selectedIndex, insertMention, close, handleInput, resolveMessage],
  );

  return (
    <Popover open={isOpen && items.length > 0} modal={false}>
      <PopoverAnchor>{children}</PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        className="w-72 p-0 max-h-64 overflow-hidden"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div ref={listRef} className="overflow-y-auto max-h-64 py-1">
          {(() => {
            let lastCategory: MentionCategory | null = null;
            const categoryLabels: Record<MentionCategory, string> = {
              agent: "Agents",
              task: "Tasks",
              mission: "Missions",
            };
            return items.map((item, i) => {
              const showHeader = item.category !== lastCategory;
              lastCategory = item.category;
              return (
                <div key={item.id}>
                  {showHeader && (
                    <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {categoryLabels[item.category]}
                    </div>
                  )}
                  <button
                    type="button"
                    data-mention-index={i}
                    className={cn(
                      "flex w-full items-center gap-2 px-2 py-1.5 text-sm text-left cursor-default rounded-sm outline-hidden select-none",
                      i === selectedIndex
                        ? "bg-accent text-accent-foreground"
                        : "text-popover-foreground hover:bg-accent/50",
                    )}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      insertMention(item);
                    }}
                  >
                    {item.icon}
                    <span className="truncate font-medium">{item.label}</span>
                    {item.secondary && item.category !== "task" && (
                      <span className="truncate text-muted-foreground text-xs">
                        {item.secondary}
                      </span>
                    )}
                    {item.badge && (
                      <Badge variant="outline" className="ml-auto text-[10px] shrink-0">
                        {item.badge}
                      </Badge>
                    )}
                  </button>
                </div>
              );
            });
          })()}
        </div>
      </PopoverContent>
    </Popover>
  );
});
