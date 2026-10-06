/**
 * Queue — compact list of queued prompts above the chat composer (Claude Desktop style).
 *
 * Header: "N queued · Auto-send". Rows: drag handle, the prompt (click to edit inline),
 * send now (↑ — while a response runs it joins that response), remove (×).
 * Also exports PendingSteers: messages sent to the running response that it has not
 * picked up yet (they join at its next step), each withdrawable.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, ChevronDown, ChevronRight, CornerDownRight, GripVertical, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import type { QueueItem } from "@/hooks/use-chat-queue";
import type { PendingSteer } from "@/hooks/use-chat-steering";

export interface QueueProps {
  items: QueueItem[];
  autoSend: boolean;
  /** Auto-send is held after a turn that did not complete ("error", "aborted", "interactive", …). */
  hold?: string;
  onUpdate: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onAutoSendChange: (value: boolean) => void;
  /** Send one item now (steers the running response, or sends it when idle). */
  onSend?: (id: string) => void;
  /** Disable send now (e.g. the assistant is waiting for an answer). */
  sendDisabled?: boolean;
  /** A response is running: send now joins it. */
  running?: boolean;
  onReorder?: (fromIdx: number, toIdx: number) => void;
  className?: string;
}

export function Queue({
  items,
  autoSend,
  hold,
  onUpdate,
  onRemove,
  onClear,
  onAutoSendChange,
  onSend,
  sendDisabled = false,
  running = false,
  onReorder,
  className,
}: QueueProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  if (items.length === 0) return null;
  return (
    <div className={cn("rounded-xl border border-border/60 bg-card/60 text-sm shadow-sm backdrop-blur-sm", className)} data-testid="chat-queue">
      <div className="flex items-center gap-2 px-2.5 py-1">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="inline-flex min-w-0 flex-1 items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
          <span className="truncate">
            <span className="font-medium text-foreground">{items.length} queued</span>
            {hold ? ` · paused (${HOLD_LABELS[hold] ?? "last answer did not finish"})` : autoSend ? " · auto-send" : " · paused"}
          </span>
        </button>
        <AutoSendSwitch checked={autoSend && !hold} onChange={onAutoSendChange} />
        <button
          type="button"
          onClick={onClear}
          className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          Clear
        </button>
      </div>
      {!collapsed && (
        <ul className="max-h-[200px] overflow-y-auto border-t border-border/40 py-0.5">
          {items.map((item, index) => (
            <QueueItemRow
              key={item.id}
              index={index}
              item={item}
              dragging={dragFrom === index}
              onUpdate={(text) => onUpdate(item.id, text)}
              onRemove={() => onRemove(item.id)}
              onSend={onSend ? () => onSend(item.id) : undefined}
              sendDisabled={sendDisabled}
              running={running}
              onDragStart={onReorder ? () => setDragFrom(index) : undefined}
              onDragEnd={() => setDragFrom(null)}
              onDrop={onReorder ? (from) => { setDragFrom(null); if (from !== index) onReorder(from, index); } : undefined}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

const HOLD_LABELS: Record<string, string> = {
  error: "last answer failed",
  aborted: "stopped",
  interactive: "waiting for your answer",
  max_turns: "last answer hit its step limit",
};

function AutoSendSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-foreground">
      <span>Auto-send</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label="Auto-send queued prompts"
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
          checked ? "bg-primary" : "bg-muted-foreground/30",
        )}
      >
        <span className={cn("inline-block h-3 w-3 transform rounded-full bg-background shadow transition-transform", checked ? "translate-x-3.5" : "translate-x-0.5")} />
      </button>
    </label>
  );
}

function QueueItemRow({
  index,
  item,
  dragging,
  onUpdate,
  onRemove,
  onSend,
  sendDisabled,
  running,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  index: number;
  item: QueueItem;
  dragging: boolean;
  onUpdate: (text: string) => void;
  onRemove: () => void;
  onSend?: () => void;
  sendDisabled?: boolean;
  running?: boolean;
  onDragStart?: () => void;
  onDragEnd: () => void;
  onDrop?: (from: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [editing]);

  const startEditing = () => {
    setDraft(item.text);
    setEditing(true);
  };

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== item.text) onUpdate(trimmed);
    if (!trimmed) setDraft(item.text);
    setEditing(false);
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDraft(item.text);
      setEditing(false);
    }
  };

  return (
    <li
      draggable={!!onDrop && !editing}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", String(index));
        e.dataTransfer.effectAllowed = "move";
        onDragStart?.();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => { if (onDrop) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
      onDrop={(e) => {
        if (!onDrop) return;
        e.preventDefault();
        const from = Number.parseInt(e.dataTransfer.getData("text/plain"), 10);
        if (Number.isFinite(from)) onDrop(from);
      }}
      className={cn("group/queue-item flex items-start gap-1.5 px-1.5 py-1 hover:bg-accent/40", dragging && "opacity-50")}
      data-testid="chat-queue-item"
    >
      {onDrop && (
        <span className="mt-0.5 cursor-grab text-muted-foreground/60 hover:text-muted-foreground active:cursor-grabbing" aria-hidden="true" title="Drag to reorder">
          <GripVertical className="h-4 w-4" />
        </span>
      )}
      {editing ? (
        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          onBlur={commit}
          rows={1}
          aria-label="Edit queued prompt"
          className="min-h-[28px] flex-1 resize-none border-primary/40 bg-background py-1 text-sm leading-snug focus-visible:ring-1 focus-visible:ring-primary/40"
        />
      ) : (
        <button
          type="button"
          onClick={startEditing}
          className="min-w-0 flex-1 cursor-text rounded py-0.5 text-left leading-snug text-foreground/90 hover:text-foreground"
          title="Click to edit"
        >
          {item.next && (
            <span className="mr-1.5 rounded bg-primary/10 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-primary">next</span>
          )}
          <span className="line-clamp-2 whitespace-pre-wrap break-words">{item.text}</span>
        </button>
      )}
      {!editing && onSend && (
        <button
          type="button"
          aria-label="Send this prompt now"
          title={sendDisabled ? "Answer the assistant first" : running ? "Send now — joins the current response" : "Send now"}
          onClick={onSend}
          disabled={sendDisabled}
          className={cn(
            "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded",
            sendDisabled ? "cursor-not-allowed text-muted-foreground/40" : "text-primary hover:bg-primary/15",
          )}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        type="button"
        aria-label="Remove from queue"
        onClick={onRemove}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

export function PendingSteers({ steers, onCancel, className }: { steers: PendingSteer[]; onCancel: (id: string) => void; className?: string }) {
  if (steers.length === 0) return null;
  return (
    <ul className={cn("space-y-1", className)} aria-label="Messages joining the current response" data-testid="pending-steers">
      {steers.map((steer) => (
        <li key={steer.id} className="flex items-start gap-2 rounded-lg border border-primary/25 bg-primary/5 px-2.5 py-1.5 text-sm">
          <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 whitespace-pre-wrap break-words text-foreground/90">{steer.content}</span>
            <span className="text-[11px] text-muted-foreground">
              {steer.status === "sending" ? (
                <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />Sending…</span>
              ) : "Joins the response at its next step"}
            </span>
          </span>
          <button
            type="button"
            aria-label="Withdraw this message"
            title="Withdraw (back to the composer)"
            onClick={() => onCancel(steer.id)}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}
