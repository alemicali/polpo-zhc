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
import { User, ListChecks, Target, FileText, Sparkles, Workflow } from "lucide-react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AgentConfig, Task, Mission, SkillWithAssignment, TemplateInfo } from "@lumea-technologies/polpo-react";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** All mentions use @ as trigger — categories are visual only in the menu */
type MentionCategory = "agent" | "task" | "mission" | "skill" | "template" | "file";

/** A mentionable file entry (path relative to project root) */
export interface MentionFile {
  name: string;
  path: string;
}

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
  toggle: () => void;
}

export interface MentionPopoverProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  agents: AgentConfig[];
  tasks: Task[];
  missions: Mission[];
  skills?: SkillWithAssignment[];
  templates?: TemplateInfo[];
  files?: MentionFile[];
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

const CATEGORY_LABELS: Record<MentionCategory, string> = {
  agent: "Agents",
  task: "Tasks",
  mission: "Missions",
  skill: "Skills",
  template: "Templates",
  file: "Files",
};

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
      ? "text-white font-semibold"
      : "text-blue-700 dark:text-blue-300 font-semibold";
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
  { textareaRef, agents, tasks, missions, skills = [], templates = [], files = [], children },
  ref,
) {
  const { isOpen, query, triggerIndex, close, handleInput } =
    useMentionTrigger(textareaRef);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [categoryFilter, setCategoryFilter] = useState<"all" | MentionCategory>("all");
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * Map of display text → wire text for all inserted mentions.
   * Display text = what the user sees (label).
   * Wire text = what gets sent to the server (ID for tasks/missions, name for agents).
   */
  const mentionsMapRef = useRef<Map<string, string>>(new Map());

  // Build structured list: agents → tasks → missions → files, all triggered by @
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

    for (const s of skills) {
      if (lowerQ && !s.name.toLowerCase().includes(lowerQ)) continue;
      result.push({
        id: `skill:${s.name}`,
        label: s.name,
        value: s.name,
        secondary: s.description,
        icon: <Sparkles className="size-4 shrink-0 text-violet-500" />,
        category: "skill",
      });
    }

    for (const t of templates) {
      if (lowerQ && !t.name.toLowerCase().includes(lowerQ)) continue;
      result.push({
        id: `template:${t.name}`,
        label: t.name,
        value: t.name,
        secondary: t.description,
        icon: <Workflow className="size-4 shrink-0 text-teal-500" />,
        category: "template",
      });
    }

    for (const f of files) {
      const matchText = `${f.name} ${f.path}`.toLowerCase();
      if (lowerQ && !matchText.includes(lowerQ)) continue;
      result.push({
        id: `file:${f.path}`,
        label: f.name,     // display: filename
        value: f.path,     // wire: relative path
        secondary: f.path !== f.name ? f.path : undefined,
        icon: <FileText className="size-4 shrink-0 text-purple-500" />,
        category: "file",
      });
    }

    return result;
  }, [query, agents, tasks, missions, skills, templates, files]);

  const filteredItems = useMemo(
    () => categoryFilter === "all" ? items : items.filter(i => i.category === categoryFilter),
    [items, categoryFilter],
  );

  const availableCategories = useMemo(() => {
    const cats = new Set(items.map(i => i.category));
    return (["agent", "task", "mission", "skill", "template", "file"] as MentionCategory[]).filter(c => cats.has(c));
  }, [items]);

  // Reset selection when the query or filtered count changes
  const filteredCount = filteredItems.length;
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, filteredCount, categoryFilter]);

  useEffect(() => {
    if (!isOpen) setCategoryFilter("all");
  }, [isOpen]);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-mention-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Ref to hold latest values for stable callbacks (avoids stale closures)
  const stateRef = useRef({ isOpen, filteredItems, selectedIndex, triggerIndex });
  stateRef.current = { isOpen, filteredItems, selectedIndex, triggerIndex };

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
      const ti = stateRef.current.triggerIndex;
      const before = value.slice(0, ti);
      const after = value.slice(cursorPos);
      const newValue = before + mention + after;

      setNativeValue(textarea, newValue);

      const newCursor = before.length + mention.length;
      textarea.setSelectionRange(newCursor, newCursor);
      textarea.focus();

      close();
    },
    [textareaRef, close],
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
        const { isOpen: open, filteredItems: fi, selectedIndex: si } = stateRef.current;
        if (!open || fi.length === 0) return;

        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % fi.length);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + fi.length) % fi.length);
        } else if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          insertMention(fi[si]);
        } else if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      },
      handleInput,
      resolveMessage,
      toggle: () => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const { isOpen: open, triggerIndex: ti } = stateRef.current;

        if (open) {
          const { value } = textarea;
          if (ti >= 0) {
            const cursor = textarea.selectionStart ?? value.length;
            const before = value.slice(0, ti);
            const trimBefore = before.endsWith(" ") && ti > 0 ? before.slice(0, -1) : before;
            const after = value.slice(cursor);
            setNativeValue(textarea, trimBefore + after);
            textarea.setSelectionRange(trimBefore.length, trimBefore.length);
          }
          close();
          textarea.focus();
          return;
        }

        // Focus first — selectionStart is null in some browsers without focus
        textarea.focus();

        const { value, selectionStart } = textarea;
        const cursor = selectionStart ?? value.length;

        const needsSpace = cursor > 0 && value[cursor - 1] !== " " && value[cursor - 1] !== "\n";
        const insert = needsSpace ? " @" : "@";

        const before = value.slice(0, cursor);
        const after = value.slice(cursor);
        const newValue = before + insert + after;

        setNativeValue(textarea, newValue);

        const newCursor = cursor + insert.length;
        textarea.setSelectionRange(newCursor, newCursor);

        handleInput();
      },
    }),
    [insertMention, close, handleInput, resolveMessage, textareaRef],
  );

  const showTabs = availableCategories.length > 1;

  return (
    <Popover open={isOpen && items.length > 0} modal={false}>
      <PopoverAnchor>{children}</PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        className="w-80 p-0 h-72 overflow-hidden flex flex-col"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {/* Category tabs */}
        {showTabs && (
          <div className="flex items-center gap-0.5 px-1.5 pt-1.5 pb-1 border-b border-border/50">
            <button
              type="button"
              className={cn(
                "px-2 py-0.5 text-[11px] font-medium rounded-md transition-colors select-none",
                categoryFilter === "all"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                setCategoryFilter("all");
              }}
            >
              All
            </button>
            {availableCategories.map((cat) => (
              <button
                key={cat}
                type="button"
                className={cn(
                  "px-2 py-0.5 text-[11px] font-medium rounded-md transition-colors select-none",
                  categoryFilter === cat
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setCategoryFilter(cat);
                }}
              >
                {CATEGORY_LABELS[cat]}
              </button>
            ))}
          </div>
        )}

        {/* Item list */}
        <div ref={listRef} className="overflow-y-auto flex-1 py-1">
          {filteredItems.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground text-center">
              No matches
            </div>
          ) : (() => {
            let lastCategory: MentionCategory | null = null;
            return filteredItems.map((item, i) => {
              const showHeader = categoryFilter === "all" && item.category !== lastCategory;
              lastCategory = item.category;
              return (
                <div key={item.id}>
                  {showHeader && (
                    <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {CATEGORY_LABELS[item.category]}
                    </div>
                  )}
                  <button
                    type="button"
                    data-mention-index={i}
                    className={cn(
                      "flex w-full items-start gap-2 px-2 py-1.5 text-sm text-left cursor-default rounded-sm outline-hidden select-none",
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
                    <span className="mt-0.5">{item.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{item.label}</span>
                        {item.badge && (
                          <Badge variant="outline" className="ml-auto text-[10px] shrink-0">
                            {item.badge}
                          </Badge>
                        )}
                      </div>
                      {item.secondary && item.category !== "task" && (
                        <p className="truncate text-muted-foreground text-xs mt-0.5">
                          {item.secondary}
                        </p>
                      )}
                    </div>
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
