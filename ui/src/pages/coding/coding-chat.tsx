/**
 * A coding chat: Claude Code or Codex in a worktree, through the CLI engine (the official program
 * on the person's own CLI account), drawn with the chat's own parts — the user's bubble, the
 * assistant's text streaming in, tool calls as collapsible lines (edits with their diff, commands
 * with their output), the composer to continue (or steer a running turn) and Stop. Risky actions
 * wait here for Approve / Deny. The engine badge shows the program and model, tokens and the CLI's
 * own cost estimate.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Check, History, KeyRound, Loader2, MessagesSquare, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import { useCodingChat, type CodingChatApproval, type CodingChatMessage } from "@polpo-ai/react";
import { Message } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { AssistantSegments, ChatUserBubble } from "@/components/chat/chat-message-parts";
import { Button } from "@/components/ui/button";
import { CHAT_COMPOSER_CLASS } from "@/lib/chat-composer";
import { chatTimeAgo } from "@/lib/chat-time";
import { cn } from "@/lib/utils";
import { toChatParts } from "./chat-parts";

const PROGRAM: Record<"claude" | "codex", string> = { claude: "Claude Code", codex: "Codex" };
function ApprovalCard({ approval, onDecide, busy }: { approval: CodingChatApproval; onDecide: (d: "approve" | "deny") => void; busy: boolean }) {
  const pending = approval.state === "pending";
  return (
    <div
      className={cn("my-2 rounded-control border px-3 py-2.5", pending ? "border-warning/40 bg-warning/5" : "border-border bg-muted/30")}
      data-testid="coding-approval"
      data-state={approval.state}
    >
      <div className="flex items-center gap-1.5 text-caption font-medium">
        <ShieldAlert className={cn("h-3.5 w-3.5", pending ? "text-warning" : "text-muted-foreground")} />
        <span>{pending ? "Needs your approval" : approval.state === "approved" ? "Approved" : approval.state === "denied" ? "Denied" : "Expired"}</span>
        <span className="text-muted-foreground">· {approval.reason}</span>
      </div>
      <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-caption text-foreground/90">{approval.summary}</pre>
      {pending && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" className="h-7 gap-1" disabled={busy} onClick={() => onDecide("approve")}>
            <Check className="h-3.5 w-3.5" /> Approve
          </Button>
          <Button size="sm" variant="outline" className="h-7 gap-1" disabled={busy} onClick={() => onDecide("deny")}>
            <X className="h-3.5 w-3.5" /> Deny
          </Button>
        </div>
      )}
    </div>
  );
}

function UserTurn({ message }: { message: CodingChatMessage }) {
  return (
    <div className="w-full px-4 py-3" data-testid="coding-chat-user">
      <div className="mx-auto flex max-w-3xl justify-end">
        <div className="max-w-[85%]">
          <ChatUserBubble text={message.text ?? ""} />
          <div className="mt-1 flex items-center justify-end gap-1.5 text-micro text-muted-foreground">
            {message.kind === "steer" && <span className="font-medium">Sent while it worked</span>}
            <span>{chatTimeAgo(new Date(message.ts))}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function AssistantTurn({ message, program, approvals, onDecide, busy }: {
  message: CodingChatMessage;
  program: string;
  approvals: Map<string, CodingChatApproval>;
  onDecide: (id: string, d: "approve" | "deny") => void;
  busy: boolean;
}) {
  const parts = useMemo(() => toChatParts(message.segments ?? []), [message.segments]);
  const streaming = !!message.streaming;
  return (
    <div className="w-full px-4 py-3" data-testid="coding-chat-assistant">
      <div className="mx-auto max-w-3xl">
        <Message from="assistant">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <p className="text-xs font-semibold">{program}</p>
              <span className="text-micro text-muted-foreground">{chatTimeAgo(new Date(message.ts))}</span>
              {message.usage && message.usage.totalTokens > 0 && (
                <span className="text-micro tabular-nums text-muted-foreground">· {message.usage.totalTokens.toLocaleString()} tokens</span>
              )}
            </div>
            {parts.map((p, i) => p.kind === "segments"
              ? <AssistantSegments key={`s-${i}`} segments={p.segments} isStreaming={streaming} />
              : approvals.get(p.approvalId)
                ? <ApprovalCard key={p.approvalId} approval={approvals.get(p.approvalId)!} busy={busy} onDecide={(d) => onDecide(p.approvalId, d)} />
                : null)}
            {streaming && !parts.length && <div className="text-small text-muted-foreground"><Shimmer>{`${program} is working…`}</Shimmer></div>}
            {message.error && (
              <p className={cn("mt-1 text-caption", message.errorKind === "interrupted" ? "text-muted-foreground" : "text-destructive")} data-testid="coding-chat-error">
                {message.error}
              </p>
            )}
          </div>
        </Message>
      </div>
    </div>
  );
}

/** No account, or a sign-in that expired: how to sign in. */
function SignInHint({ program, error }: { program: string; error: string }) {
  return (
    <div className="mx-auto my-4 max-w-3xl px-4" data-testid="coding-chat-signin">
      <div className="flex gap-3 rounded-card border border-warning/40 bg-warning/5 px-4 py-3">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 space-y-1.5">
          <p className="text-small font-medium">Sign in to {program} with your own account</p>
          <p className="text-caption text-muted-foreground">{error}</p>
          <Button asChild size="sm" variant="outline" className="h-7">
            <Link to="/config?section=harnesses">Open CLI accounts</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface CodingChatPaneProps {
  chatId?: string;
  /** The chat could not be created. */
  createError?: string;
  kind: "claude" | "codex";
  active: boolean;
  /** The program changed files: refresh the changes panel. */
  onFilesChanged?: () => void;
}

export function CodingChatPane({ chatId, createError, kind, active, onFilesChanged }: CodingChatPaneProps) {
  const { session, isLoading, error, send, stop, approve, deny } = useCodingChat(chatId, { onFilesChanged: () => onFilesChanged?.() });
  const [busy, setBusy] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const program = PROGRAM[session?.kind ?? kind];
  const running = session?.status === "running" || session?.status === "awaiting-approval";
  const approvals = useMemo(() => new Map((session?.approvals ?? []).map((a) => [a.id, a])), [session?.approvals]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const last = session?.messages.at(-1);
  const lastSize = (last?.segments?.length ?? 0) + (last?.segments?.reduce((n, s) => n + (s.type === "text" ? s.text.length : 0), 0) ?? 0);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [session?.messages.length, lastSize, active]);

  const decide = async (id: string, d: "approve" | "deny") => {
    setBusy(true);
    try { await (d === "approve" ? approve(id) : deny(id)); } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  const submit = async ({ text, files }: PromptInputMessage) => {
    if (files.length) { toast.error("Attachments can't be sent to a coding session: send the text only"); throw new Error("attachments"); }
    if (!text.trim()) throw new Error("empty");
    try {
      await send(text);
      setHasDraft(false);
      atBottom.current = true;
    } catch (err) {
      toast.error((err as Error).message);
      throw err;
    }
  };

  const signIn = session && (session.errorKind === "no-account" || session.errorKind === "not-signed-in" || session.errorKind === "not-allowed") && session.status === "error";
  const failure = createError ?? (error ? error.message : undefined);

  return (
    <div className={cn("absolute inset-0 flex min-h-0 flex-col bg-background", !active && "invisible")} data-testid="coding-chat" aria-hidden={!active}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-4 text-caption text-muted-foreground" data-testid="coding-chat-badge">
        <span className="rounded-badge border border-border bg-muted/50 px-1.5 py-px font-medium text-foreground">{program} · CLI</span>
        {session?.model && <span className="font-mono">{session.model}</span>}
        {session?.account && <span title="The CLI account (your own sign-in)">· {session.account}</span>}
        <span className="flex-1" />
        {session && session.usage.totalTokens > 0 && <span className="tabular-nums">{session.usage.totalTokens.toLocaleString()} tokens</span>}
        {session && session.costUsd > 0 && <span className="tabular-nums" title="The CLI's own estimate: your plan pays">· ~${session.costUsd.toFixed(2)}</span>}
        {running && <Loader2 className="h-3.5 w-3.5 animate-spin text-info motion-reduce:animate-none" aria-label="Working" />}
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {failure ? (
          <div className="mx-auto my-6 flex max-w-3xl items-start gap-2 px-4 text-small text-destructive" data-testid="coding-chat-failed">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {failure}
          </div>
        ) : !session && (isLoading || !chatId) ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-primary motion-reduce:animate-none" /></div>
        ) : session && !session.messages.length && !signIn ? (
          <div className="flex flex-col items-center justify-center gap-1 py-16 text-center text-muted-foreground">
            <MessagesSquare className="h-6 w-6 opacity-40" />
            <p className="text-small">Ask {program} to work in this worktree</p>
            <p className="max-w-sm text-caption">It edits files and runs commands here on its own; installs, network access, git push and anything outside the worktree ask you first.</p>
          </div>
        ) : null}
        {session?.continuedFrom && (
          <div className="mx-auto mt-3 max-w-3xl px-4" data-testid="coding-chat-continued" data-status={session.continuedFrom.status}>
            <p className="flex items-start gap-2 rounded-control border border-border/70 bg-muted/30 px-3 py-2 text-caption text-muted-foreground">
              <History className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{session.continuedFrom.note}</span>
            </p>
          </div>
        )}
        {session?.messages.map((m) => m.role === "user"
          ? <UserTurn key={m.id} message={m} />
          : <AssistantTurn key={m.id} message={m} program={program} approvals={approvals} busy={busy} onDecide={(id, d) => void decide(id, d)} />)}
        {signIn && session?.lastError && <SignInHint program={program} error={session.lastError} />}
        {session?.status === "error" && !signIn && session.lastError && !session.messages.at(-1)?.error && (
          <p className="mx-auto max-w-3xl px-4 pb-3 text-caption text-destructive">{session.lastError}</p>
        )}
      </div>

      <div className="shrink-0 px-4 pb-3 pt-2" data-testid="coding-chat-composer">
        <div className="mx-auto max-w-3xl">
          <PromptInput onSubmit={submit} submissionKey={chatId ?? "pending"} className={CHAT_COMPOSER_CLASS}>
            <PromptInputTextarea
              placeholder={running ? `Steer ${program} while it works…` : `Ask ${program}…`}
              disabled={!session}
              maxLength={100_000}
              aria-label={`Message ${program}`}
              onInput={(e) => setHasDraft(e.currentTarget.value.trim().length > 0)}
            />
            <PromptInputFooter>
              <span className="pl-1 text-caption text-muted-foreground">
                {running ? "Enter sends to the running turn" : session?.cwd ? <span className="font-mono">{session.cwd}</span> : null}
              </span>
              <PromptInputSubmit
                status={running ? "streaming" : undefined}
                onStop={() => { void stop().catch((err: unknown) => toast.error((err as Error).message)); }}
                disabled={!session || (!running && !hasDraft)}
                aria-label={running ? "Stop" : "Send"}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </div>
  );
}
