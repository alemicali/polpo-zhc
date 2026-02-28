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

type TriggerChar = "@" | "#" | "%";

interface TriggerState {
  isOpen: boolean;
  triggerChar: TriggerChar | null;
  query: string;
  triggerIndex: number;
}

interface MentionItem {
  id: string;
  label: string;
  secondary?: string;
  badge?: string;
  icon: ReactNode;
  triggerChar: TriggerChar;
}

export interface MentionPopoverHandle {
  handleTextareaKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  handleInput: () => void;
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

const TRIGGER_CHARS = new Set<string>(["@", "#", "%"]);

function useMentionTrigger(textareaRef: RefObject<HTMLTextAreaElement | null>) {
  const [state, setState] = useState<TriggerState>({
    isOpen: false,
    triggerChar: null,
    query: "",
    triggerIndex: -1,
  });

  const close = useCallback(() => {
    setState({ isOpen: false, triggerChar: null, query: "", triggerIndex: -1 });
  }, []);

  // Called on every input event from the textarea (wired via onInput in chat.tsx)
  const handleInput = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const { value, selectionStart } = textarea;
    if (selectionStart == null) {
      close();
      return;
    }

    // Scan backwards from cursor looking for an unquoted trigger char
    let i = selectionStart - 1;
    while (i >= 0) {
      const ch = value[i];
      // Space means we passed the potential mention without finding trigger
      if (ch === " " || ch === "\n") {
        close();
        return;
      }
      if (TRIGGER_CHARS.has(ch)) {
        // Trigger must be at start of string or preceded by whitespace
        if (i === 0 || value[i - 1] === " " || value[i - 1] === "\n") {
          const query = value.slice(i + 1, selectionStart);
          setState({
            isOpen: true,
            triggerChar: ch as TriggerChar,
            query,
            triggerIndex: i,
          });
          return;
        }
        // Not a valid trigger position
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

/** Format mention text like the TUI: @name or @"name with spaces" */
function formatMention(triggerChar: TriggerChar, name: string): string {
  return /[\s]/.test(name)
    ? `${triggerChar}"${name}"`
    : `${triggerChar}${name}`;
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
  const { isOpen, triggerChar, query, triggerIndex, close, handleInput } =
    useMentionTrigger(textareaRef);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Build flat list of filtered items
  const items = useMemo<MentionItem[]>(() => {
    const lowerQ = query.toLowerCase();
    const result: MentionItem[] = [];

    // @ shows all categories (agents first), # only tasks, % only missions
    const showAgents = triggerChar === "@";
    const showTasks = triggerChar === "@" || triggerChar === "#";
    const showMissions = triggerChar === "@" || triggerChar === "%";

    if (showAgents) {
      for (const a of agents) {
        if (lowerQ && !a.name.toLowerCase().includes(lowerQ)) continue;
        result.push({
          id: `agent:${a.name}`,
          label: a.name,
          secondary: a.role,
          icon: <User className="size-4 shrink-0" />,
          triggerChar: "@",
        });
      }
    }

    if (showTasks) {
      for (const t of tasks) {
        const matchText = `${t.title} ${t.id}`.toLowerCase();
        if (lowerQ && !matchText.includes(lowerQ)) continue;
        result.push({
          id: `task:${t.id}`,
          label: t.title,
          secondary: t.id,
          badge: t.status,
          icon: <ListChecks className="size-4 shrink-0" />,
          triggerChar: "#",
        });
      }
    }

    if (showMissions) {
      for (const m of missions) {
        if (lowerQ && !m.name.toLowerCase().includes(lowerQ)) continue;
        result.push({
          id: `mission:${m.id}`,
          label: m.name,
          badge: m.status,
          icon: <Target className="size-4 shrink-0" />,
          triggerChar: "%",
        });
      }
    }

    return result;
  }, [triggerChar, query, agents, tasks, missions]);

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  // Scroll selected item into view
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

      // Use task ID for tasks, name for agents/missions
      const mentionName = item.triggerChar === "#"
        ? (item.secondary ?? item.label) // secondary = task id
        : item.label;
      const mention = formatMention(item.triggerChar, mentionName) + " ";

      const before = value.slice(0, triggerIndex);
      const after = value.slice(cursorPos);
      const newValue = before + mention + after;

      setNativeValue(textarea, newValue);

      // Set cursor after inserted mention
      const newCursor = before.length + mention.length;
      textarea.setSelectionRange(newCursor, newCursor);
      textarea.focus();

      close();
    },
    [textareaRef, triggerIndex, close],
  );

  // Expose keyboard + input handlers via imperative handle
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
    }),
    [isOpen, items, selectedIndex, insertMention, close, handleInput],
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
          {items.map((item, i) => (
            <button
              key={item.id}
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
                // Prevent textarea blur
                e.preventDefault();
                insertMention(item);
              }}
            >
              {item.icon}
              <span className="truncate font-medium">{item.label}</span>
              {item.secondary && item.triggerChar !== "#" && (
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
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
});
