"use client";

import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { MessageResponse } from "@/components/ai-elements/message";
import { FilePreviewDialog } from "@/components/shared/file-preview";
import { useFilePreview } from "@/components/shared/use-file-preview";
import { mimeFromPath, previewCategory } from "@/components/shared/file-preview-utils";
import { cn } from "@/lib/utils";
import { apiUrl, config } from "@/lib/config";
import { ToolResultArtifacts } from "@/components/shared/tool-result-artifacts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import {
  Loader2,
  ChevronRight,
  Check,
  Copy,
  ExternalLink,
  PictureInPicture2,
} from "lucide-react";
import { useChatSandbox } from "@/components/sandbox/sandbox-context";
import { PLACEMENT_INFO, toolPlacement } from "@/lib/sandbox-api";
import { EnvFromVaultChips } from "@/components/ai-elements/env-from-vault-chips";
import { envFromVaultRefs } from "@/components/ai-elements/env-from-vault";
import { describeTool, isRunning, toolErrorReason, type ToolCallInfo } from "./tool-summary";

// ── Types ──

export type { ToolState, ToolCallInfo, ToolSummary } from "./tool-summary";

// ── Helpers ──

/** Tools whose first argument is a file path that can be previewed */
const FILE_TOOLS = new Set(["write", "edit", "read"]);

/** Extract file path from tool arguments, only if the file type is previewable */
function extractFilePath(tool: ToolCallInfo): string | undefined {
  if (!FILE_TOOLS.has(tool.name)) return undefined;
  const args = tool.arguments;
  if (!args) return undefined;
  // write/read/edit all use "path" as the key
  const p = args.path ?? args.filePath ?? args.file;
  if (typeof p !== "string") return undefined;
  // Only return path if the file has a known previewable MIME type
  const mime = mimeFromPath(p);
  if (!mime) return undefined;
  const category = previewCategory(mime);
  if (category === "binary") return undefined;
  return p;
}

/** Friendly labels for client-side interactive tools (preparing state) */
const INTERACTIVE_LABELS: Record<string, string> = {
  ask_user: "Asking a question…",
  open_file: "Opening file…",
  create_mission: "Creating mission…",
  set_vault_entry: "Saving to vault…",
  update_vault_credentials: "Updating vault credentials…",
  navigate_to: "Navigating…",
  open_tab: "Opening tab…",
  set_design: "Updating design…",
};

function formatProgress(progress: NonNullable<ToolCallInfo["progress"]>): string {
  const elapsed = typeof progress.elapsedMs === "number"
    ? ` · ${Math.max(0, Math.floor(progress.elapsedMs / 1000))}s`
    : "";
  return `${progress.status ?? progress.message}${elapsed}`;
}

/** Output that reads best as monospace text (JSON, shell, files) rather than markdown. */
const MONO_RESULT_TOOLS = new Set([
  "bash", "read", "read_file", "write", "write_file", "edit", "edit_file", "glob", "grep", "grep_files", "ls",
]);

function looksLikeJson(text: string): boolean {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

function looksLikeDiff(text: string): boolean {
  return /^@@ .* @@/m.test(text) || (/^\+[^+]/m.test(text) && /^-[^-]/m.test(text) && /^(?:---|\+\+\+) /m.test(text));
}

function prettyJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

// ── Small pieces ──

/** Copy icon that shows on hover of its section. */
function CopyIcon({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }).catch(() => undefined);
      }}
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/section:opacity-100"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function Section({ title, copyText, children }: { title: string; copyText?: string; children: ReactNode }) {
  return (
    <div className="group/section min-w-0">
      <div className="flex items-center gap-1 text-micro text-muted-foreground/70">
        <span>{title}</span>
        {copyText ? <CopyIcon text={copyText} label={`Copy ${title.toLowerCase()}`} /> : null}
      </div>
      {children}
    </div>
  );
}

const MONO = "max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-caption";

function DiffText({ text }: { text: string }) {
  return (
    <pre className={cn(MONO, "text-muted-foreground")}>
      {text.split("\n").map((line, i) => (
        <span
          key={i}
          className={cn(
            "block",
            line.startsWith("+") && !line.startsWith("+++") && "text-success",
            line.startsWith("-") && !line.startsWith("---") && "text-destructive",
            line.startsWith("@@") && "text-info",
          )}
        >
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

/** Where the tool ran: plain muted text for sandboxed tools when the chat has a sandbox. */
function SandboxNote({ toolName }: { toolName: string }) {
  const sandbox = useChatSandbox();
  if (!sandbox || sandbox.provider === "local") return null;
  const placement = toolPlacement(toolName);
  if (placement === "host") return null;
  const where = sandbox.provider === "bwrap" ? "bubblewrap" : sandbox.provider === "e2b" ? "E2B" : sandbox.provider === "daytona" ? "Daytona" : sandbox.provider;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0 text-caption text-muted-foreground/70">sandbox · {where}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64 text-xs">{PLACEMENT_INFO[placement].description}</TooltipContent>
    </Tooltip>
  );
}

// ── Details (expanded) ──

function ToolDetails({ tool }: { tool: ToolCallInfo }) {
  const draftRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!tool.argumentsText || !draftRef.current) return;
    draftRef.current.scrollTop = draftRef.current.scrollHeight;
  }, [tool.argumentsText]);

  const args = tool.arguments && Object.keys(tool.arguments).length > 0 ? tool.arguments : undefined;
  const argsText = args ? JSON.stringify(args, null, 2) : undefined;
  // bash (Polpo), Bash (Claude Code), shell (Codex: the command may be a list)
  const lower = tool.name.toLowerCase();
  const rawCommand = lower === "bash" || lower === "shell" ? args?.command : undefined;
  const command = typeof rawCommand === "string" ? rawCommand : Array.isArray(rawCommand) ? rawCommand.map(String).join(" ") : undefined;
  const result = tool.result;
  const isError = tool.state === "error";
  const mono = !!result && (MONO_RESULT_TOOLS.has(lower) || looksLikeJson(result) || isError);
  // an edit with its diff: the change instead of the raw input
  const diff = tool.diff;

  const hasAnything = !!tool.progress || !!args || !!tool.argumentsText || !!result || !!diff;
  if (!hasAnything) {
    return (
      <p className="text-caption text-muted-foreground/70">
        {isRunning(tool.state) ? "Waiting for input…" : "No input or output."}
      </p>
    );
  }

  return (
    <div className="space-y-1.5" data-testid="tool-call-details">
      {tool.state === "calling" && tool.progress && (
        <p className="text-caption text-muted-foreground" title={tool.progress.message}>
          {formatProgress(tool.progress)}
        </p>
      )}

      {command !== undefined ? (
        <Section title="Command" copyText={command}>
          <pre className={cn(MONO, "text-muted-foreground")}>$ {command}</pre>
        </Section>
      ) : diff ? (
        <Section title="Changes" copyText={diff}>
          <div data-testid="tool-call-diff"><DiffText text={diff} /></div>
        </Section>
      ) : args && argsText ? (
        <Section title="Input" copyText={argsText}>
          <pre className={cn(MONO, "text-muted-foreground")}>{argsText}</pre>
        </Section>
      ) : null}

      {!args && tool.argumentsText && (
        <Section title="Input draft" copyText={tool.argumentsText}>
          <pre ref={draftRef} className={cn(MONO, "text-muted-foreground")}>{tool.argumentsText}</pre>
        </Section>
      )}

      {result && (
        <Section title={isError ? "Error" : "Output"} copyText={result}>
          {isError ? (
            <pre className={cn(MONO, "text-destructive")}>{result}</pre>
          ) : looksLikeDiff(result) ? (
            <DiffText text={result} />
          ) : mono ? (
            <pre className={cn(MONO, "text-muted-foreground")}>{looksLikeJson(result) ? prettyJson(result) : result}</pre>
          ) : (
            <div className="max-h-48 overflow-auto text-caption text-muted-foreground">
              <MessageResponse>{result}</MessageResponse>
            </div>
          )}
          {!isError && <ToolResultArtifacts result={result} className="mt-1.5" />}
        </Section>
      )}
    </div>
  );
}

// ── One tool call: a muted line, details on click ──

export interface ToolInvocationProps extends HTMLAttributes<HTMLDivElement> {
  tool: ToolCallInfo;
  defaultOpen?: boolean;
  /** Inside a group's box: the details are plain indented text, no box of their own. */
  nested?: boolean;
}

export function ToolInvocation({
  tool,
  defaultOpen,
  nested = false,
  className,
  ...props
}: ToolInvocationProps) {
  // Live input streaming in: open so it can be watched; closed again once the call is done.
  const shouldOpenForStreamingInput = tool.state === "preparing" && !!tool.argumentsText;
  const [open, setOpen] = useState(defaultOpen ?? shouldOpenForStreamingInput);
  const [movingToBackground, setMovingToBackground] = useState(false);
  const filePath = extractFilePath(tool);
  const vaultEnv = tool.name === "bash" ? envFromVaultRefs(tool.arguments) : [];
  const { previewState, openPreview, closePreview } = useFilePreview();

  // Adjusted during render when the inputs change (not on mount, so defaultOpen holds);
  // manual toggles in between are kept until the next change.
  const [prevAuto, setPrevAuto] = useState({ shouldOpenForStreamingInput, state: tool.state });
  if (prevAuto.shouldOpenForStreamingInput !== shouldOpenForStreamingInput || prevAuto.state !== tool.state) {
    setPrevAuto({ shouldOpenForStreamingInput, state: tool.state });
    if (shouldOpenForStreamingInput) {
      setOpen(true);
    } else if (tool.state === "completed" || tool.state === "interrupted") {
      setOpen(false);
    }
  }

  const handleFileClick = () => {
    if (!filePath) return;
    const basename = filePath.split("/").pop() ?? filePath;
    openPreview({
      label: basename,
      path: filePath,
      mimeType: mimeFromPath(filePath),
    });
  };

  const moveToBackground = async () => {
    setMovingToBackground(true);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      const response = await fetch(apiUrl("/api/v1/background-waits/from-active"), {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ toolCallId: tool.id }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? "Could not move wait to background");
      window.dispatchEvent(new Event("polpo:background-waits-changed"));
      toast.success("Wait moved to background");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not move wait to background");
      setMovingToBackground(false);
    }
  };

  // Interactive / client-side tools: a muted "Asking a question…" line while preparing
  // with no input yet, nothing once executed (their own card takes over). When argument
  // deltas arrive, fall through to the regular line so the payload can be watched.
  const interactiveLabel = INTERACTIVE_LABELS[tool.name];
  if (interactiveLabel) {
    if (tool.state === "preparing" && !tool.argumentsText && !tool.arguments) {
      return (
        <div
          className={cn("flex items-center gap-1.5 py-0.5 text-small text-muted-foreground", className)}
          data-testid="tool-call"
          data-tool-state={tool.state}
          {...props}
        >
          <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" />
          <span className="text-shimmer">{interactiveLabel}</span>
        </div>
      );
    }
    if (tool.state !== "preparing") return null;
  }

  const summary = describeTool(tool);
  const running = isRunning(tool.state);
  const isError = tool.state === "error";
  const reason = isError ? toolErrorReason(tool) : undefined;

  return (
    <>
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className={cn(nested ? "py-0.5" : "my-1.5", "min-w-0 text-small", className)}
        data-testid="tool-call"
        data-tool-state={tool.state}
        {...props}
      >
        <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <CollapsibleTrigger
            className="group/line flex min-w-0 items-center gap-1.5 text-left transition-colors hover:text-foreground"
            data-testid="tool-call-line"
            title={summary.text}
          >
            <span
              className={cn(
                "min-w-0 truncate",
                running && "text-shimmer",
                isError && "text-destructive",
                tool.state === "interrupted" && "text-warning",
              )}
            >
              {summary.text}
            </span>
            {running && tool.state === "calling" && tool.progress && (
              <span className="min-w-0 shrink truncate text-caption text-muted-foreground/70" title={tool.progress.message}>
                · {formatProgress(tool.progress)}
              </span>
            )}
            {isError && (
              <span className="min-w-0 shrink truncate text-destructive/80" data-testid="tool-call-reason">
                · {reason ?? "failed"}
              </span>
            )}
            {tool.state === "interrupted" && <span className="shrink-0 text-warning/80">· waiting</span>}
            <ChevronRight
              className="h-3 w-3 shrink-0 transition-transform group-data-[state=open]/line:rotate-90 motion-reduce:transition-none"
              aria-hidden
            />
          </CollapsibleTrigger>
          {filePath && tool.state === "completed" && (
            <button
              type="button"
              onClick={handleFileClick}
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
              title={`Open ${filePath}`}
              aria-label={`Open ${filePath.split("/").pop()}`}
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
          <EnvFromVaultChips refs={vaultEnv} />
          <SandboxNote toolName={tool.name} />
          {tool.name === "wait_for_task" && tool.state === "calling" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-50"
                  onClick={() => { void moveToBackground(); }}
                  disabled={movingToBackground}
                  aria-label="Move wait to background"
                >
                  {movingToBackground
                    ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                    : <PictureInPicture2 className="h-3 w-3" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">Move wait to background</TooltipContent>
            </Tooltip>
          )}
        </div>

        <CollapsibleContent>
          <div
            className={cn(
              "mt-1 min-w-0",
              nested ? "pl-3" : "rounded-control bg-muted/30 px-2.5 py-1.5",
            )}
          >
            <ToolDetails tool={tool} />
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* File preview dialog (only mounts when active) */}
      <FilePreviewDialog preview={previewState} onClose={closePreview} />
    </>
  );
}

// ── Grouped tool calls (2+): "Used 4 tools ›", one light box with a line each ──

export interface ToolCallGroupProps extends HTMLAttributes<HTMLDivElement> {
  tools: ToolCallInfo[];
}

/** Is this an interactive tool that has already been executed? (should be hidden) */
function isHiddenInteractive(t: ToolCallInfo): boolean {
  return t.name in INTERACTIVE_LABELS && t.state !== "preparing";
}

export function ToolCallGroup({ tools, className, ...props }: ToolCallGroupProps) {
  // Separate: interactive tools preparing (inline), hidden interactive (executed), visible tools
  const preparingInteractive = tools.filter((t) => t.name in INTERACTIVE_LABELS && t.state === "preparing");
  const visibleTools = tools.filter((t) => !isHiddenInteractive(t));

  // Only non-interactive tools go in the group
  const listTools = visibleTools.filter((t) => !(t.name in INTERACTIVE_LABELS));
  const active = listTools.filter((t) => isRunning(t.state));
  const errorCount = listTools.filter((t) => t.state === "error").length;
  const isCalling = active.length > 0;
  const hasError = errorCount > 0;
  const shouldOpenForStreamingInput = listTools.some((t) => t.state === "preparing" && !!t.argumentsText);
  const [open, setOpen] = useState(shouldOpenForStreamingInput);

  // Auto-open on streaming input, auto-close when calls finish. Adjusted during render
  // when the inputs change (no effect round-trip); manual toggles in between are kept.
  const [prevAutoOpen, setPrevAutoOpen] = useState({ isCalling, shouldOpenForStreamingInput });
  if (
    prevAutoOpen.isCalling !== isCalling ||
    prevAutoOpen.shouldOpenForStreamingInput !== shouldOpenForStreamingInput
  ) {
    setPrevAutoOpen({ isCalling, shouldOpenForStreamingInput });
    if (shouldOpenForStreamingInput) {
      setOpen(true);
    } else if (!isCalling) {
      setOpen(false);
    }
  }

  const n = listTools.length;
  const current = isCalling ? describeTool(active[active.length - 1]).text : undefined;

  return (
    <>
      {/* Interactive tools in preparing state — shown inline above the group */}
      {preparingInteractive.map((tool) => (
        <ToolInvocation key={tool.id} tool={tool} />
      ))}

      {n > 0 && (
        <Collapsible
          open={open}
          onOpenChange={setOpen}
          className={cn("my-1.5 min-w-0 text-small", className)}
          data-testid="tool-call-group"
          data-tool-state={isCalling ? "calling" : hasError ? "error" : "completed"}
          {...props}
        >
          <CollapsibleTrigger
            className="group/line flex min-w-0 max-w-full items-center gap-1.5 text-left text-muted-foreground transition-colors hover:text-foreground"
            data-testid="tool-call-group-line"
          >
            {/* Plain text, no status icons: "Used 4 tools, 1 failed ›" */}
            <span className={cn("shrink-0", isCalling && "text-shimmer")}>
              {`${isCalling ? "Using" : "Used"} ${n} ${n === 1 ? "tool" : "tools"}`}
              {hasError && (
                <span className="text-destructive" data-testid="tool-call-group-errors">
                  {`, ${errorCount} failed`}
                </span>
              )}
            </span>
            {current && (
              <span className="min-w-0 truncate text-caption text-muted-foreground/70">· {current}</span>
            )}
            <ChevronRight
              className="h-3 w-3 shrink-0 transition-transform group-data-[state=open]/line:rotate-90 motion-reduce:transition-none"
              aria-hidden
            />
          </CollapsibleTrigger>

          <CollapsibleContent>
            <div className="mt-1 min-w-0 rounded-control bg-muted/30 px-2.5 py-1">
              {listTools.map((tool) => (
                <ToolInvocation key={tool.id} tool={tool} nested />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </>
  );
}

// ── Inline list of tool calls (messages without segments) ──

export interface ToolCallListProps extends HTMLAttributes<HTMLDivElement> {
  tools: ToolCallInfo[];
}

export function ToolCallList({ tools, className, ...props }: ToolCallListProps) {
  if (tools.length === 0) return null;
  if (tools.length > 1) return <ToolCallGroup tools={tools} className={className} {...props} />;

  return <ToolInvocation tool={tools[0]} className={className} {...props} />;
}
