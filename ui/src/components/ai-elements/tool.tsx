"use client";

import type { HTMLAttributes } from "react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  FilePreviewDialog,
  useFilePreview,
  mimeFromPath,
  previewCategory,
} from "@/components/shared/file-preview";
import { cn } from "@/lib/utils";
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  Wrench,
  FileText,
} from "lucide-react";

// ── Types ──

export type ToolState = "preparing" | "calling" | "completed" | "error" | "interrupted";

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  result?: string;
  state: ToolState;
}

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
  go_to_file: "Navigating to file…",
  open_file: "Opening file…",
  create_mission: "Creating mission…",
  set_vault_entry: "Saving to vault…",
};

/** Convert tool_name to "Tool Name" */
function formatToolName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getStateIcon(state: ToolState) {
  switch (state) {
    case "preparing":
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
    case "calling":
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
    case "completed":
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
    case "error":
      return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
    case "interrupted":
      return <AlertCircle className="h-3.5 w-3.5 text-amber-500" />;
  }
}

function getStateBadge(state: ToolState) {
  switch (state) {
    case "preparing":
      return (
        <Badge variant="outline" className="text-[9px] font-normal border-muted-foreground/30 text-muted-foreground">
          Preparing
        </Badge>
      );
    case "calling":
      return (
        <Badge variant="outline" className="text-[9px] font-normal border-primary/30 text-primary">
          Running
        </Badge>
      );
    case "completed":
      return (
        <Badge variant="outline" className="text-[9px] font-normal border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
          Done
        </Badge>
      );
    case "error":
      return (
        <Badge variant="outline" className="text-[9px] font-normal border-destructive/30 text-destructive">
          Error
        </Badge>
      );
    case "interrupted":
      return (
        <Badge variant="outline" className="text-[9px] font-normal border-amber-500/30 text-amber-600 dark:text-amber-400">
          Waiting
        </Badge>
      );
  }
}

// ── Components ──

export interface ToolInvocationProps extends HTMLAttributes<HTMLDivElement> {
  tool: ToolCallInfo;
  defaultOpen?: boolean;
}

export function ToolInvocation({
  tool,
  defaultOpen,
  className,
  ...props
}: ToolInvocationProps) {
  const isOpen = defaultOpen ?? tool.state === "error";
  const filePath = extractFilePath(tool);
  const { previewState, openPreview, closePreview } = useFilePreview();

  const handleFileClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Don't toggle the collapsible
    if (!filePath) return;
    const basename = filePath.split("/").pop() ?? filePath;
    openPreview({
      label: basename,
      path: filePath,
      mimeType: mimeFromPath(filePath),
    });
  };

  // Interactive tools in "preparing" state → minimal inline label
  const interactiveLabel = INTERACTIVE_LABELS[tool.name];
  if (interactiveLabel && tool.state === "preparing") {
    return (
      <div className={cn("flex items-center gap-2 py-2 text-xs text-muted-foreground", className)} {...props}>
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>{interactiveLabel}</span>
      </div>
    );
  }

  return (
    <>
      <Collapsible defaultOpen={isOpen} {...props}>
        <div
          className={cn(
            "rounded-lg border bg-card/50 text-card-foreground overflow-hidden my-4",
            tool.state === "error" && "border-destructive/30",
            tool.state === "calling" && "border-primary/20",
            tool.state === "completed" && "border-border/50",
            className,
          )}
        >
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/30 transition-colors group">
            <Wrench className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-medium truncate">
              {formatToolName(tool.name)}
            </span>
            {/* File path for write/edit/read tools — shown in all states */}
            {filePath && (
              <button
                onClick={handleFileClick}
                className={cn(
                  "flex items-center gap-1 text-[11px] truncate max-w-[50%]",
                  tool.state === "completed"
                    ? "text-primary hover:text-primary/80 hover:underline cursor-pointer"
                    : "text-muted-foreground cursor-default",
                )}
                title={filePath}
                disabled={tool.state !== "completed"}
              >
                <FileText className="h-3 w-3 shrink-0" />
                <span className="truncate">{filePath.split("/").pop()}</span>
              </button>
            )}
            <span className="flex-1" />
            {getStateIcon(tool.state)}
            {getStateBadge(tool.state)}
            <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 shrink-0" />
          </CollapsibleTrigger>

          <CollapsibleContent>
            <div className="border-t border-border/40 px-3 py-2 space-y-2">
              {/* Input arguments */}
              {tool.arguments && Object.keys(tool.arguments).length > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                    Input
                  </p>
                  <div className="text-xs bg-muted/50 rounded-md px-2.5 py-1.5 max-h-32 overflow-y-auto">
                    <MessageResponse>{`\`\`\`json\n${JSON.stringify(tool.arguments, null, 2)}\n\`\`\``}</MessageResponse>
                  </div>
                </div>
              )}

              {/* Result */}
              {tool.result && (
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                    {tool.state === "error" ? "Error" : "Result"}
                  </p>
                  <div
                    className={cn(
                      "text-xs rounded-md px-2.5 py-1.5 max-h-48 overflow-y-auto",
                      tool.state === "error"
                        ? "bg-destructive/10 text-destructive"
                        : "bg-muted/50",
                    )}
                  >
                    <MessageResponse>{tool.result}</MessageResponse>
                  </div>
                </div>
              )}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      {/* File preview dialog (rendered per tool invocation, only mounts when active) */}
      <FilePreviewDialog preview={previewState} onClose={closePreview} />
    </>
  );
}

// ── Grouped tool calls (2+) — single collapsible row ──

export interface ToolCallGroupProps extends HTMLAttributes<HTMLDivElement> {
  tools: ToolCallInfo[];
}

/** Grouped collapsible for 2+ consecutive tool calls — shows a summary row */
export function ToolCallGroup({ tools, className, ...props }: ToolCallGroupProps) {
  const activeCount = tools.filter((t) => t.state === "calling" || t.state === "preparing").length;
  const errorCount = tools.filter((t) => t.state === "error").length;
  const isCalling = activeCount > 0;
  const hasError = errorCount > 0;

  const summaryIcon = isCalling
    ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
    : hasError
      ? <AlertCircle className="h-3.5 w-3.5 text-destructive" />
      : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;

  const names = tools.map((t) => formatToolName(t.name));
  // Show first 2 names + "and N more" if > 2
  const preview = names.length <= 2
    ? names.join(", ")
    : `${names[0]}, ${names[1]} +${names.length - 2}`;

  return (
    <Collapsible defaultOpen={hasError} {...props}>
      <div
        className={cn(
          "rounded-lg border bg-card/50 text-card-foreground overflow-hidden my-4",
          isCalling && "border-primary/20",
          hasError && "border-destructive/30",
          !isCalling && !hasError && "border-border/50",
          className,
        )}
      >
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/30 transition-colors group">
          <Wrench className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground">
            {isCalling ? `Working on ${tools.length} tools` : `Used ${tools.length} tools`}
          </span>
          <span className="text-[10px] text-muted-foreground/60 truncate flex-1">
            {preview}
          </span>
          {summaryIcon}
          <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 shrink-0" />
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="border-t border-border/40 px-2 py-2 space-y-1.5">
            {tools.map((tool) => (
              <ToolInvocation key={tool.id} tool={tool} />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// ── Inline list of tool calls ──

export interface ToolCallListProps extends HTMLAttributes<HTMLDivElement> {
  tools: ToolCallInfo[];
}

export function ToolCallList({ tools, className, ...props }: ToolCallListProps) {
  if (tools.length === 0) return null;

  return (
    <div className={cn("space-y-2 my-2.5", className)} {...props}>
      {tools.map((tool) => (
        <ToolInvocation key={tool.id} tool={tool} />
      ))}
    </div>
  );
}
