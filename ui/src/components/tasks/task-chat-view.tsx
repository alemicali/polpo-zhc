/**
 * Tasks → Execution → Chat: a task's run(s) drawn exactly like a chat conversation, with the
 * chat's own message parts (user bubble, assistant avatar and body: text, reasoning, tool calls
 * grouped "Used N tools ›") and the chat's composer at the bottom to steer or continue the task.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import { GitBranch, Loader2, MessagesSquare } from "lucide-react";
import { toast } from "sonner";
import type { AgentConfig, AgentProcess, RunActivityEntry, Task, UseTaskDirectionsReturn } from "@polpo-ai/react";
import { Message } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { AssistantSegments, ChatAssistantAvatar, ChatUserBubble } from "@/components/chat/chat-message-parts";
import { buildTaskTranscript, runLabel, type TaskChatMessage, type TaskTranscriptRun } from "@/lib/task-transcript";
import { chatTimeAgo } from "@/lib/chat-time";
import { CHAT_COMPOSER_CLASS } from "@/lib/chat-composer";
import { sendTaskDirection, taskSteering } from "@/hooks/use-task-steering";
import { cn } from "@/lib/utils";

const USER_KIND_LABEL: Record<NonNullable<TaskChatMessage["kind"]>, string> = {
  prompt: "Instructions",
  steer: "Steer",
  follow_up: "Follow-up",
  continue: "Continue",
};

function RunDivider({ run }: { run: TaskTranscriptRun }) {
  return (
    <div role="separator" aria-label={runLabel(run)} className="flex items-center gap-3 px-4 py-3" data-testid="task-chat-run-divider">
      <div className="h-px flex-1 bg-border" />
      <span className="flex shrink-0 items-center gap-1.5 text-caption text-muted-foreground">
        <GitBranch className="h-3 w-3" />
        <span className="font-medium text-foreground">{runLabel(run)}</span>
        {run.status && <span className="capitalize">· {run.status}</span>}
        {run.startedAt && <span>· {format(new Date(run.startedAt), "MMM d, HH:mm")}</span>}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function UserTurn({ message }: { message: TaskChatMessage }) {
  return (
    <div className="group w-full py-4 px-4" data-testid="task-chat-user" data-kind={message.kind}>
      <div className="mx-auto max-w-3xl">
        <div className="flex justify-end">
          <div className="max-w-[85%]">
            <ChatUserBubble text={message.content} />
            <div className="flex items-center justify-end gap-1.5 mt-1 text-micro text-muted-foreground">
              {message.kind && <span className="font-medium">{USER_KIND_LABEL[message.kind]}</span>}
              {message.directionStatus && message.directionStatus !== "applied" && (
                <span className={cn("capitalize", message.directionStatus === "failed" && "text-destructive")}>· {message.directionStatus}</span>
              )}
              {message.ts && <span>· {chatTimeAgo(new Date(message.ts))}</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AssistantTurn({ message, name, avatar, isStreaming }: { message: TaskChatMessage; name: string; avatar?: string; isStreaming: boolean }) {
  return (
    <div className="group w-full py-4 px-4" data-testid="task-chat-assistant">
      <div className="mx-auto max-w-3xl">
        <Message from="assistant">
          <div className="flex gap-3">
            <ChatAssistantAvatar avatar={avatar} name={name} isAgent />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <p className="text-xs font-semibold">{name}</p>
                {message.ts && <span className="text-micro text-muted-foreground">{chatTimeAgo(new Date(message.ts))}</span>}
              </div>
              <AssistantSegments segments={message.segments} isStreaming={isStreaming} />
            </div>
          </div>
        </Message>
      </div>
    </div>
  );
}

export interface TaskChatViewProps {
  task: Task;
  process?: AgentProcess;
  agent?: AgentConfig;
  entries: RunActivityEntry[];
  isLoading?: boolean;
  directions: UseTaskDirectionsReturn;
}

export function TaskChatView({ task, process, agent, entries, isLoading, directions }: TaskChatViewProps) {
  const isActive = task.status === "in_progress" || task.status === "assigned";
  const transcript = useMemo(() => buildTaskTranscript({
    prompt: task.description,
    createdAt: task.createdAt,
    entries,
    directions: directions.directions,
    runs: task.runs,
    isActive,
  }), [task.description, task.createdAt, task.runs, entries, directions.directions, isActive]);

  const name = agent?.identity?.displayName ?? task.assignTo;
  const avatar = agent?.identity?.avatar;
  const lastRun = transcript[transcript.length - 1];
  const lastMessage = lastRun?.messages[lastRun.messages.length - 1];

  // Follow new messages while the reader is at the bottom (like the chat).
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const messageCount = transcript.reduce((n, run) => n + run.messages.length, 0);
  const lastSegments = lastMessage?.segments.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messageCount, lastSegments]);

  return (
    <div className="flex flex-1 min-h-0 flex-col" data-testid="task-chat-view">
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto"
        onScroll={(event) => {
          const el = event.currentTarget;
          atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : (
          transcript.map((run, index) => (
            <section key={run.key} aria-label={runLabel(run)}>
              {(index > 0 || transcript.length > 1) && run.attempt > 0 && <RunDivider run={run} />}
              {run.messages.map((message) => {
                const isStreaming = isActive && run === lastRun && message === lastMessage && message.role === "assistant";
                return message.role === "user"
                  ? <UserTurn key={message.id} message={message} />
                  : <AssistantTurn key={message.id} message={message} name={name} avatar={avatar} isStreaming={isStreaming} />;
              })}
            </section>
          ))
        )}
        {isActive && !isLoading && (
          <div className="w-full px-4 pb-4">
            <div className="mx-auto max-w-3xl pl-10 text-small text-muted-foreground" data-testid="task-chat-working">
              <Shimmer>{`${name} is working…`}</Shimmer>
            </div>
          </div>
        )}
        {!isLoading && entries.length === 0 && !isActive && (
          <div className="flex flex-col items-center justify-center pb-8 text-muted-foreground">
            <MessagesSquare className="h-6 w-6 mb-1 opacity-40" />
            <p className="text-xs">No run yet: the conversation starts when the task runs</p>
          </div>
        )}
      </div>
      <TaskChatComposer task={task} process={process} directions={directions} />
    </div>
  );
}

/** The chat's composer (PromptInput), wired to the task's directions: steer a live run, else continue. */
export function TaskChatComposer({ task, process, directions }: { task: Task; process?: AgentProcess; directions: UseTaskDirectionsReturn }) {
  const steering = taskSteering(task, process);
  const [hasDraft, setHasDraft] = useState(false);
  const [confirmSideEffects, setConfirmSideEffects] = useState(false);
  const disabled = !!steering.disabledReason;
  const canSend = hasDraft && !disabled && !directions.isSending && (!steering.needsConfirmation || confirmSideEffects);

  const handleSubmit = async ({ text, files }: PromptInputMessage) => {
    if (files.length > 0) {
      toast.error("Attachments can't be sent to a task: send the text only");
      throw new Error("attachments");
    }
    if (!text.trim() || !canSend) throw new Error("not sendable");
    try {
      const result = await sendTaskDirection(steering, directions.sendDirection, text, confirmSideEffects);
      setConfirmSideEffects(false);
      setHasDraft(false);
      toast.success(result.action === "continue" ? "Continuation queued" : "Direction queued");
    } catch (cause) {
      toast.error((cause as Error).message);
      throw cause;
    }
  };

  return (
    <div className="shrink-0 px-4 pb-3 pt-2" data-testid="task-chat-composer">
      <div className="mx-auto max-w-3xl">
        <PromptInput onSubmit={handleSubmit} submissionKey={task.id} className={CHAT_COMPOSER_CLASS}>
          <PromptInputTextarea
            placeholder={steering.disabledReason ?? steering.placeholder}
            disabled={disabled}
            maxLength={8_000}
            aria-label={steering.actionLabel}
            onInput={(event) => setHasDraft(event.currentTarget.value.trim().length > 0)}
          />
          <PromptInputFooter>
            <div className="flex min-w-0 items-center gap-2 pl-1 text-caption">
              {steering.needsConfirmation && !disabled && (
                <label className="flex items-center gap-2 text-warning">
                  <input
                    type="checkbox"
                    checked={confirmSideEffects}
                    onChange={(event) => setConfirmSideEffects(event.target.checked)}
                    className="h-3.5 w-3.5 accent-warning"
                  />
                  External actions may repeat
                </label>
              )}
              {!steering.needsConfirmation && !disabled && (
                <span className="text-muted-foreground">{steering.isLive ? "Steers the current run" : "Continues the task in a new run"}</span>
              )}
            </div>
            <PromptInputSubmit
              status={directions.isSending ? "submitted" : undefined}
              disabled={!canSend}
              aria-label={steering.actionLabel}
            />
          </PromptInputFooter>
        </PromptInput>
        {steering.disabledReason && (
          <p className="mt-1 text-center text-micro text-muted-foreground" data-testid="task-chat-composer-hint">{steering.disabledReason}</p>
        )}
      </div>
    </div>
  );
}
