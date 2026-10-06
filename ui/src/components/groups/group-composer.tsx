/**
 * Group composer: Enter sends, Shift+Enter adds a line, "@" opens a list of
 * the group's agents and inserts "@name ".
 */
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { cn } from "@/lib/utils";
import { MemberAvatar } from "./group-members";
import type { GroupMember } from "./use-member-directory";

interface MentionState {
  /** Index of the "@" in the textarea value. */
  index: number;
  query: string;
}

/** The "@query" the caret is in, if any: "@" at start or after whitespace, no whitespace after it. */
function findMention(value: string, caret: number): MentionState | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === " " || ch === "\n" || ch === "\t") return null;
    if (ch === "@") {
      const prev = i === 0 ? " " : value[i - 1];
      return prev === " " || prev === "\n" || prev === "\t" ? { index: i, query: value.slice(i + 1, caret) } : null;
    }
  }
  return null;
}

/** Set an uncontrolled textarea's value so React and PromptInput see the change. */
function setNativeValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/** What gets typed after "@" — the agent id, which the server matches mentions against. */
function mentionHandle(member: GroupMember): string {
  return member.id;
}

export function GroupComposer({ members, onSend, placeholder, autoFocus }: {
  members: GroupMember[];
  onSend: (text: string) => Promise<unknown>;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [selected, setSelected] = useState(0);
  const [sending, setSending] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);

  const items = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return members.filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [members, mention]);
  const open = mention !== null && items.length > 0;
  // New "@query" → highlight the first match again (adjusted during render).
  const mentionKey = mention ? `${mention.index}:${mention.query}` : "";
  const [shownKey, setShownKey] = useState(mentionKey);
  if (shownKey !== mentionKey) {
    setShownKey(mentionKey);
    setSelected(0);
  }
  const activeIndex = Math.min(selected, Math.max(0, items.length - 1));

  const detect = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const caret = textarea.selectionStart ?? textarea.value.length;
    setMention(findMention(textarea.value, caret));
  }, []);

  const close = useCallback(() => setMention(null), []);

  const insert = useCallback((member: GroupMember) => {
    const textarea = textareaRef.current;
    if (!textarea || !mention) return;
    const caret = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, mention.index);
    const after = textarea.value.slice(caret).replace(/^\S*/, "");
    const token = `@${mentionHandle(member)} `;
    setNativeValue(textarea, before + token + after.replace(/^ /, ""));
    const pos = before.length + token.length;
    textarea.setSelectionRange(pos, pos);
    textarea.focus();
    setMention(null);
  }, [mention]);

  const openMentions = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    const caret = textarea.selectionStart ?? textarea.value.length;
    const value = textarea.value;
    const needsSpace = caret > 0 && !/\s/.test(value[caret - 1]);
    const token = needsSpace ? " @" : "@";
    setNativeValue(textarea, value.slice(0, caret) + token + value.slice(caret));
    const pos = caret + token.length;
    textarea.setSelectionRange(pos, pos);
    detect();
  }, [detect]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((activeIndex + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((activeIndex - 1 + items.length) % items.length);
    } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      insert(items[activeIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!text) return;
    setSending(true);
    try {
      await onSend(text);
      setHasDraft(false);
    } catch (error) {
      toast.error("Message not sent", { description: error instanceof Error ? error.message : String(error) });
      throw error; // keeps the draft in the composer
    } finally {
      setSending(false);
    }
  };

  return (
    <Popover open={open} modal={false}>
      <PopoverAnchor asChild>
        <div>
          <PromptInput
            onSubmit={handleSubmit}
            maxFiles={0}
            onError={() => toast.info("Attachments aren't supported in groups yet")}
            className="[&_[data-slot=input-group]]:rounded-[calc(var(--radius)+8px)] [&_[data-slot=input-group]]:focus-within:ring-0 [&_[data-slot=input-group]]:focus-within:border-input"
          >
            <PromptInputTextarea
              ref={textareaRef}
              autoFocus={autoFocus}
              placeholder={placeholder ?? "Message the group…"}
              onKeyDown={handleKeyDown}
              onInput={(e) => {
                setHasDraft(e.currentTarget.value.trim().length > 0);
                detect();
              }}
              onClick={detect}
              onKeyUp={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") detect();
              }}
              onBlur={close}
            />
            <PromptInputFooter>
              <div className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={openMentions}
                  aria-label="Mention an agent"
                  title="Mention an agent"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                >
                  <span className="font-mono text-sm font-semibold">@</span>
                </button>
              </div>
              <PromptInputSubmit
                status={sending ? "submitted" : undefined}
                disabled={sending || !hasDraft}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="flex max-h-80 w-[min(22rem,92vw)] flex-col overflow-hidden rounded-md border border-border bg-popover p-0 text-popover-foreground shadow-[0_18px_60px_-30px_rgba(0,0,0,0.35)]"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          if (textareaRef.current?.contains(e.target as Node)) e.preventDefault();
          else close();
        }}
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-border bg-muted/35 px-3 py-2">
          <div className="flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background font-mono text-sm font-bold">@</div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">Mention an agent</p>
            <p className="truncate text-[11px] text-muted-foreground">Mentioned agents always reply.</p>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1" role="listbox" aria-label="Group agents">
          {items.map((member, index) => (
            <button
              key={member.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors outline-hidden select-none",
                index === activeIndex ? "bg-accent" : "hover:bg-accent/60",
              )}
              onMouseEnter={() => setSelected(index)}
              onMouseDown={(e) => {
                e.preventDefault();
                insert(member);
              }}
            >
              <MemberAvatar member={member} size="sm" />
              <div className="min-w-0 flex-1 leading-tight">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[13px] font-semibold">{member.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">@{mentionHandle(member)}</span>
                </div>
                {member.role && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{member.role}</p>}
              </div>
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em]">↑↓</span>
          <span>move</span>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em]">Enter</span>
          <span>insert</span>
          <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.12em]">Esc</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
