/**
 * Queue — compact stack of queued prompts that sits above the chat composer.
 *
 * Inspired by the AI-SDK Elements `Queue` component: a vertical list of
 * numbered items, hover-revealed Edit/Delete actions, inline editing on
 * click, a header with an "Auto-send" toggle and a "Clear all" button,
 * and an empty-state hint. The look stays inline with our Tailwind
 * conventions so it slots cleanly between the chat thread and the
 * PromptInput card.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Pencil, Trash2, X, ListOrdered } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { QueueItem } from "@/hooks/use-chat-queue";

export interface QueueProps {
  items: QueueItem[];
  autoSend: boolean;
  onUpdate: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onAutoSendChange: (value: boolean) => void;
  /** Optional close button (X) on the header to hide the queue panel. */
  onClose?: () => void;
  /** Optional reorder (drag-and-drop or programmatic). */
  onReorder?: (fromIdx: number, toIdx: number) => void;
  className?: string;
}

export function Queue({
  items,
  autoSend,
  onUpdate,
  onRemove,
  onClear,
  onAutoSendChange,
  onClose,
  onReorder,
  className,
}: QueueProps) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border/60 bg-card/50 shadow-sm backdrop-blur-sm",
        className,
      )}
    >
      <QueueHeader
        count={items.length}
        autoSend={autoSend}
        onAutoSendChange={onAutoSendChange}
        onClear={onClear}
        onClose={onClose}
      />
      {items.length === 0 ? (
        <QueueEmpty />
      ) : (
        <ul className="max-h-[200px] overflow-y-auto py-1">
          {items.map((item, idx) => (
            <QueueItemRow
              key={item.id}
              index={idx}
              total={items.length}
              item={item}
              onUpdate={(text) => onUpdate(item.id, text)}
              onRemove={() => onRemove(item.id)}
              onReorder={onReorder}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Header ────────────────────────────────────────────────────────────

function QueueHeader({
  count,
  autoSend,
  onAutoSendChange,
  onClear,
  onClose,
}: {
  count: number;
  autoSend: boolean;
  onAutoSendChange: (v: boolean) => void;
  onClear: () => void;
  onClose?: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5">
      <ListOrdered className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
        Up next <span className="text-muted-foreground">({count})</span>
      </p>
      <AutoSendSwitch checked={autoSend} onChange={onAutoSendChange} />
      {count > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px] text-muted-foreground hover:text-destructive"
          onClick={onClear}
        >
          Clear
        </Button>
      )}
      {onClose && (
        <button
          type="button"
          aria-label="Hide queue"
          onClick={onClose}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

// ─── Auto-send switch (tiny inline, no extra dep) ──────────────────────

function AutoSendSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-foreground">
      <span>Auto-send</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
          checked ? "bg-primary" : "bg-muted-foreground/30",
        )}
      >
        <span
          className={cn(
            "inline-block h-3 w-3 transform rounded-full bg-background shadow transition-transform",
            checked ? "translate-x-3.5" : "translate-x-0.5",
          )}
        />
      </button>
    </label>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────

function QueueEmpty() {
  return (
    <div className="px-3 py-3 text-center text-[11px] text-muted-foreground">
      Queue is empty — press the queue button to stash a prompt.
    </div>
  );
}

// ─── Item row ─────────────────────────────────────────────────────────

function QueueItemRow({
  index,
  total,
  item,
  onUpdate,
  onRemove,
  onReorder,
}: {
  index: number;
  total: number;
  item: QueueItem;
  onUpdate: (text: string) => void;
  onRemove: () => void;
  onReorder?: (fromIdx: number, toIdx: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep local draft in sync when the underlying item changes (e.g. from
  // a reorder, or a parallel update from another tab).
  useEffect(() => {
    if (!editing) setDraft(item.text);
  }, [editing, item.text]);

  // Auto-focus + auto-size on entering edit mode.
  useEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft(item.text);
      setEditing(false);
      return;
    }
    if (trimmed !== item.text) onUpdate(trimmed);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(item.text);
    setEditing(false);
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  // Native HTML5 drag-and-drop for reorder. Falls back gracefully when
  // onReorder isn't provided.
  const dragProps = onReorder
    ? {
        draggable: true as const,
        onDragStart: (e: React.DragEvent<HTMLLIElement>) => {
          e.dataTransfer.setData("text/plain", String(index));
          e.dataTransfer.effectAllowed = "move";
        },
        onDragOver: (e: React.DragEvent<HTMLLIElement>) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        },
        onDrop: (e: React.DragEvent<HTMLLIElement>) => {
          e.preventDefault();
          const raw = e.dataTransfer.getData("text/plain");
          const from = Number.parseInt(raw, 10);
          if (Number.isFinite(from) && from !== index) onReorder(from, index);
        },
      }
    : {};

  return (
    <li
      {...dragProps}
      className={cn(
        "group/queue-item flex items-start gap-2 px-3 py-1.5 transition-colors",
        "hover:bg-accent/40",
        onReorder && "cursor-grab active:cursor-grabbing",
      )}
    >
      <span
        className={cn(
          "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-mono font-medium text-muted-foreground",
          index === 0 && "bg-primary/10 text-primary",
        )}
        aria-label={`Position ${index + 1} of ${total}`}
      >
        {index + 1}
      </span>

      {editing ? (
        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          onBlur={commit}
          rows={1}
          className="min-h-[28px] flex-1 resize-none border-primary/40 bg-background py-1 text-sm leading-snug focus-visible:ring-1 focus-visible:ring-primary/40"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="min-w-0 flex-1 cursor-text rounded text-left text-sm leading-snug text-foreground/90 hover:text-foreground"
          title="Click to edit"
        >
          <span className="line-clamp-2 whitespace-pre-wrap break-words">{item.text}</span>
        </button>
      )}

      <div
        className={cn(
          "flex shrink-0 items-center gap-0.5 transition-opacity",
          editing ? "opacity-100" : "opacity-0 group-hover/queue-item:opacity-100 focus-within:opacity-100",
        )}
      >
        {!editing && (
          <button
            type="button"
            aria-label="Edit queued prompt"
            onClick={() => setEditing(true)}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
        <button
          type="button"
          aria-label="Remove from queue"
          onClick={onRemove}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </li>
  );
}
