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
import { User, ListChecks, Target, FileText, Folder, BookOpen, Workflow } from "lucide-react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { AgentConfig, Task, Mission, SkillWithAssignment, PlaybookInfo } from "@polpo-ai/react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

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

/** A mentionable filesystem entry (path relative to project root). */
export interface MentionFile {
  name: string;
  path: string;
  type?: "file" | "directory";
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

type MentionRow =
  | { type: "header"; key: string; category: MentionCategory; count: number }
  | { type: "item"; key: string; item: MentionItem; itemIndex: number };

type MentionTab = "all" | MentionCategory;

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
  onTriggerOpen?: (trigger: MentionTrigger) => void;
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
  file: "Files & folders",
};

const CATEGORY_ORDER: MentionCategory[] = ["agent", "task", "mission", "file", "skill", "playbook"];

const TRIGGER_COPY: Record<MentionTrigger, { title: string; subtitle: string }> = {
  "@": {
    title: "Mentions",
    subtitle: "Agents, tasks, missions, files and folders. Keep typing to filter.",
  },
  "/": {
    title: "Skills",
    subtitle: "Skills and playbooks available for this chat.",
  },
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
  { textareaRef, agents, tasks, missions, skills = [], templates = [], files = [], onTriggerOpen, children },
  ref,
) {
  const { isOpen, query, triggerIndex, trigger, close, handleInput } =
    useMentionTrigger(textareaRef);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<MentionTab>("all");
  const listRef = useRef<VirtuosoHandle>(null);

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
          icon: f.type === "directory"
            ? <Folder className="size-4 shrink-0 text-sky-500" />
            : <FileText className="size-4 shrink-0 text-purple-500" />,
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
          icon: <BookOpen className="size-4 shrink-0 text-violet-500" />,
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
    () => activeTab === "all" ? items : items.filter((item) => item.category === activeTab),
    [activeTab, items],
  );

  const availableCategories = useMemo(() => {
    const cats = new Set(items.map(i => i.category));
    return CATEGORY_ORDER.filter(c => cats.has(c));
  }, [items]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<MentionCategory, number>();
    for (const item of items) {
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const tabs = useMemo<MentionTab[]>(
    () => ["all", ...availableCategories],
    [availableCategories],
  );

  const rows = useMemo<MentionRow[]>(() => {
    const result: MentionRow[] = [];
    let lastCategory: MentionCategory | null = null;

    filteredItems.forEach((item, itemIndex) => {
      if (item.category !== lastCategory) {
        result.push({
          type: "header",
          key: `header:${item.category}`,
          category: item.category,
          count: categoryCounts.get(item.category) ?? 0,
        });
        lastCategory = item.category;
      }

      result.push({
        type: "item",
        key: item.id,
        item,
        itemIndex,
      });
    });

    return result;
  }, [categoryCounts, filteredItems]);

  // Reset selection when the query or filtered count changes
  const filteredCount = filteredItems.length;
  useEffect(() => {
    setSelectedIndex(0);
  }, [activeTab, query, filteredCount]);

  useEffect(() => {
    setActiveTab("all");
  }, [trigger]);

  useEffect(() => {
    if (isOpen) onTriggerOpen?.(trigger);
  }, [isOpen, onTriggerOpen, trigger]);

  useEffect(() => {
    const rowIndex = rows.findIndex(
      (row) => row.type === "item" && row.itemIndex === selectedIndex,
    );
    if (rowIndex >= 0) {
      listRef.current?.scrollToIndex({ index: rowIndex, align: "center", behavior: "auto" });
    }
  }, [rows, selectedIndex]);

  // Ref to hold latest values for stable callbacks (avoids stale closures)
  const stateRef = useRef({ isOpen, filteredItems, selectedIndex, triggerIndex, trigger, tabs, activeTab });
  stateRef.current = { isOpen, filteredItems, selectedIndex, triggerIndex, trigger, tabs, activeTab };

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
          tabs: currentTabs,
          activeTab: currentTab,
        } = stateRef.current;
        if (!open) return;

        const PAGE = 5;

        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          if (currentTabs.length <= 1) return;
          e.preventDefault();
          const idx = Math.max(0, currentTabs.indexOf(currentTab));
          const dir = e.key === "ArrowRight" ? 1 : -1;
          const next = currentTabs[(idx + dir + currentTabs.length) % currentTabs.length];
          setActiveTab(next);
          return;
        }

        if (fi.length === 0) return;

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

  const triggerCopy = TRIGGER_COPY[trigger];

  return (
    <Popover open={isOpen && items.length > 0} modal={false}>
      <PopoverAnchor>{children}</PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        className="flex h-[24rem] w-[min(30rem,92vw)] flex-col overflow-hidden rounded-md border border-border bg-popover p-0 text-popover-foreground shadow-[0_18px_60px_-30px_rgba(0,0,0,0.35)]"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-border bg-muted/35 px-3 py-2.5">
          <div className="flex h-8 min-w-8 items-center justify-center rounded-md border border-border bg-background font-mono text-sm font-bold text-foreground">
            {trigger}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold text-foreground">{triggerCopy.title}</p>
              {query ? (
                <span className="truncate font-mono text-[10px] text-muted-foreground">
                  query: {query}
                </span>
              ) : null}
            </div>
            <p className="truncate text-[11px] text-muted-foreground">{triggerCopy.subtitle}</p>
          </div>
          <span className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
            {filteredItems.length}
          </span>
        </div>

        {tabs.length > 1 && (
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-background/80 px-2 py-1.5">
            {tabs.map((tab) => {
              const active = tab === activeTab;
              const label = tab === "all" ? "All" : CATEGORY_LABELS[tab];
              const count = tab === "all" ? items.length : categoryCounts.get(tab) ?? 0;
              return (
                <button
                  key={tab}
                  type="button"
                  className={cn(
                    "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-colors",
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setActiveTab(tab);
                  }}
                >
                  <span>{label}</span>
                  <span className="font-mono text-[9px] tabular-nums opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Item list */}
        <div className="min-h-0 flex-1">
          {filteredItems.length === 0 ? (
            <div className="px-3 py-4 text-center font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
              No matches
            </div>
          ) : (
            <Virtuoso
              ref={listRef}
              data={rows}
              className="h-full"
              itemContent={(_, row) => {
                if (row.type === "header") {
                  return (
                    <div className="sticky top-0 z-10 flex items-center gap-2 border-y border-border/60 bg-popover/95 px-3 py-1.5 backdrop-blur">
                      <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                        {CATEGORY_LABELS[row.category]}
                      </span>
                      <span className="ml-auto rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-muted-foreground">
                        {row.count}
                      </span>
                    </div>
                  );
                }

                const { item, itemIndex } = row;
                return (
                  <button
                    type="button"
                    className={cn(
                      "group/row flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors outline-hidden select-none",
                      itemIndex === selectedIndex
                        ? "bg-accent"
                        : "hover:bg-accent/60",
                    )}
                    onMouseEnter={() => setSelectedIndex(itemIndex)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      insertMention(item);
                    }}
                  >
                    <span
                      className={cn(
                        "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground group-hover/row:text-foreground",
                        itemIndex === selectedIndex && "border-foreground/40",
                      )}
                      aria-hidden
                    >
                      {item.icon}
                    </span>
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-[13px] font-semibold text-foreground">{item.label}</span>
                        {item.category === "file" && (
                          <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70">
                            file
                          </span>
                        )}
                      </div>
                      {item.secondary && item.category !== "task" && (
                        <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                          {item.secondary}
                        </p>
                      )}
                    </div>
                    {item.badge && (
                      <kbd className="ml-auto shrink-0 rounded border border-border bg-muted/60 px-1 py-px font-mono text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                        {item.badge}
                      </kbd>
                    )}
                  </button>
                );
              }}
            />
          )}
        </div>

        {/* Keyboard shortcut hints — sticky footer */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className="hidden sm:inline">Use</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.12em]">←→</span>
            <span>tabs</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.12em]">↑↓</span>
            <span>to move</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.12em]">Enter</span>
            <span>to insert</span>
          </span>
          <button
            type="button"
            onClick={close}
            className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:text-foreground"
          >
            Esc
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
});
