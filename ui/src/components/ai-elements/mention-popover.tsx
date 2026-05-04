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
import type { AgentConfig, Task, Mission, SkillWithAssignment, PlaybookInfo } from "@polpo-ai/react";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/**
 * Two trigger characters power the popover:
 *   - `@` → entity mentions (agents, tasks, missions, files)
 *   - `/` → slash commands (skills + playbooks/templates)
 *
 * Categories are visual only in the menu — the trigger char itself decides
 * which categories are eligible.
 */
type MentionCategory = "agent" | "task" | "mission" | "skill" | "playbook" | "file";

export type MentionTrigger = "@" | "/";

/** A mentionable file entry (path relative to project root) */
export interface MentionFile {
  name: string;
  path: string;
}

interface TriggerState {
  isOpen: boolean;
  query: string;
  triggerIndex: number;
  trigger: MentionTrigger;
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
  /** Manually open the popover with the given trigger char (default `@`). */
  toggle: (trigger?: MentionTrigger) => void;
}

export interface MentionPopoverProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  agents: AgentConfig[];
  tasks: Task[];
  missions: Mission[];
  skills?: SkillWithAssignment[];
  templates?: PlaybookInfo[];
  files?: MentionFile[];
  children: ReactNode;
}

// ────────────────────────────────────────────────────────────────────────────
// Hook: useMentionTrigger
// ────────────────────────────────────────────────────────────────────────────

function isTouchMobileInput() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 768;
}

function useMentionTrigger(textareaRef: RefObject<HTMLTextAreaElement | null>) {
  const [state, setState] = useState<TriggerState>({
    isOpen: false,
    query: "",
    triggerIndex: -1,
    trigger: "@",
  });

  const close = useCallback(() => {
    setState({ isOpen: false, query: "", triggerIndex: -1, trigger: "@" });
  }, []);

  const handleInput = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const { value, selectionStart } = textarea;
    if (selectionStart == null) {
      close();
      return;
    }

    // Scan backwards from cursor looking for `@` or `/`. Whichever comes
    // first (closest to cursor without a whitespace/break in between) wins.
    // `/` only counts as a trigger when at start-of-message or after
    // whitespace — otherwise URLs and paths would constantly open the menu.
    let i = selectionStart - 1;
    while (i >= 0) {
      const ch = value[i];
      if (ch === " " || ch === "\n") {
        close();
        return;
      }
      if (ch === "/") {
        if (isTouchMobileInput()) {
          close();
          return;
        }

        // Slash trigger requires beginning-of-line or whitespace before it
        const prev = i > 0 ? value[i - 1] : "\n";
        if (prev === " " || prev === "\n" || i === 0) {
          const query = value.slice(i + 1, selectionStart);
          setState({ isOpen: true, query, triggerIndex: i, trigger: "/" });
          return;
        }
        // Not a valid slash command position — keep scanning, may still find @
        i--;
        continue;
      }
      if (ch === "@") {
        if (i === 0 || value[i - 1] === " " || value[i - 1] === "\n") {
          const query = value.slice(i + 1, selectionStart);
          setState({ isOpen: true, query, triggerIndex: i, trigger: "@" });
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
  playbook: "Playbooks",
  file: "Files",
};


/** Format a name as @name / /name (or quoted variant when it contains spaces). */
function formatMention(name: string, trigger: MentionTrigger = "@"): string {
  return /[\s]/.test(name) ? `${trigger}"${name}"` : `${trigger}${name}`;
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
  const { isOpen, query, triggerIndex, trigger, close, handleInput } =
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

  // Build structured list — items differ based on which trigger fired.
  //   `@` → navigation shortcuts + agents + tasks + missions + files
  //   `/` → skills + playbooks/templates (slash-command-style)
  const items = useMemo<MentionItem[]>(() => {
    const lowerQ = query.toLowerCase();
    const result: MentionItem[] = [];

    if (trigger === "@") {
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
          label: t.title,
          value: t.id,
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
          label: m.name,
          value: m.id,
          badge: m.status,
          icon: <Target className="size-4 shrink-0 text-emerald-500" />,
          category: "mission",
        });
      }

      for (const f of files) {
        const matchText = `${f.name} ${f.path}`.toLowerCase();
        if (lowerQ && !matchText.includes(lowerQ)) continue;
        result.push({
          id: `file:${f.path}`,
          label: f.name,
          value: f.path,
          secondary: f.path !== f.name ? f.path : undefined,
          icon: <FileText className="size-4 shrink-0 text-purple-500" />,
          category: "file",
        });
      }
    } else {
      // `/` — slash commands (skills + playbook templates)
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
          id: `playbook:${t.name}`,
          label: t.name,
          value: t.name,
          secondary: t.description,
          icon: <Workflow className="size-4 shrink-0 text-teal-500" />,
          category: "playbook",
        });
      }
    }

    return result;
  }, [query, trigger, agents, tasks, missions, skills, templates, files]);

  const filteredItems = useMemo(
    () => categoryFilter === "all" ? items : items.filter(i => i.category === categoryFilter),
    [items, categoryFilter],
  );

  const availableCategories = useMemo(() => {
    const cats = new Set(items.map(i => i.category));
    return (["navigation", "agent", "task", "mission", "skill", "playbook", "file"] as MentionCategory[]).filter(c => cats.has(c));
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
  const stateRef = useRef({ isOpen, filteredItems, selectedIndex, triggerIndex, trigger, availableCategories, categoryFilter });
  stateRef.current = { isOpen, filteredItems, selectedIndex, triggerIndex, trigger, availableCategories, categoryFilter };

  const insertMention = useCallback(
    (item: MentionItem) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const value = textarea.value;
      const cursorPos = textarea.selectionStart ?? value.length;
      const ti = stateRef.current.triggerIndex;
      const tr = stateRef.current.trigger;

      // Display text: always use label (human-readable). Wire text: use value.
      const displayMention = formatMention(item.label, tr);
      const wireMention = formatMention(item.value, tr);

      // Track the mapping for submit-time resolution
      if (displayMention !== wireMention) {
        mentionsMapRef.current.set(displayMention, wireMention);
      }

      const mention = displayMention + " ";
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
        const {
          isOpen: open,
          filteredItems: fi,
          selectedIndex: si,
          availableCategories: cats,
          categoryFilter: cf,
        } = stateRef.current;
        if (!open || fi.length === 0) return;

        const PAGE = 5;
        const meta = e.metaKey || e.ctrlKey;

        // Cycle category tabs with Cmd/Ctrl + ←/→ (only when there's >1 category)
        if (meta && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
          if (cats.length <= 1) return;
          e.preventDefault();
          const sequence: Array<"all" | MentionCategory> = ["all", ...cats];
          const idx = sequence.indexOf(cf);
          const dir = e.key === "ArrowRight" ? 1 : -1;
          const next = sequence[(idx + dir + sequence.length) % sequence.length];
          setCategoryFilter(next);
          return;
        }

        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % fi.length);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + fi.length) % fi.length);
        } else if (e.key === "PageDown") {
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + PAGE, fi.length - 1));
        } else if (e.key === "PageUp") {
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - PAGE, 0));
        } else if (e.key === "Home") {
          e.preventDefault();
          setSelectedIndex(0);
        } else if (e.key === "End") {
          e.preventDefault();
          setSelectedIndex(fi.length - 1);
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
      toggle: (trigger: MentionTrigger = "@") => {
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
        const insert = needsSpace ? ` ${trigger}` : trigger;

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

        {/* Keyboard shortcut hints — sticky footer */}
        <div className="shrink-0 border-t border-border/50 px-2 py-1.5 flex items-center gap-2.5 text-[9.5px] text-muted-foreground/70 select-none flex-wrap">
          <KbdHint keys={["↑", "↓"]} label="navigate" />
          <KbdHint keys={["↵"]} label="pick" />
          {availableCategories.length > 1 && (
            <KbdHint keys={["⌘", "←/→"]} label="category" />
          )}
          <KbdHint keys={["esc"]} label="close" />
        </div>
      </PopoverContent>
    </Popover>
  );
});

function KbdHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k, i) => (
        <kbd
          key={i}
          className="inline-flex items-center justify-center min-w-[14px] h-3.5 px-1 rounded-[3px] border border-border/70 bg-muted/40 font-mono text-[8.5px] font-medium leading-none"
        >
          {k}
        </kbd>
      ))}
      <span className="ml-0.5">{label}</span>
    </span>
  );
}
