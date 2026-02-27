"use client";

import type { HTMLAttributes } from "react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  Wrench,
} from "lucide-react";

// ── Types ──

export type ToolState = "calling" | "completed" | "error";

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  result?: string;
  state: ToolState;
}

// ── Helpers ──

/** Convert tool_name to "Tool Name" */
function formatToolName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getStateIcon(state: ToolState) {
  switch (state) {
    case "calling":
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
    case "completed":
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
    case "error":
      return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
  }
}

function getStateBadge(state: ToolState) {
  switch (state) {
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

  return (
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
          <span className="text-xs font-medium flex-1 truncate">
            {formatToolName(tool.name)}
          </span>
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
  );
}

// ── Grouped tool calls (2+) — single collapsible row ──

export interface ToolCallGroupProps extends HTMLAttributes<HTMLDivElement> {
  tools: ToolCallInfo[];
}

/** Grouped collapsible for 2+ consecutive tool calls — shows a summary row */
export function ToolCallGroup({ tools, className, ...props }: ToolCallGroupProps) {
  const callingCount = tools.filter((t) => t.state === "calling").length;
  const errorCount = tools.filter((t) => t.state === "error").length;
  const isCalling = callingCount > 0;
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
            {isCalling ? `Running ${tools.length} tools` : `Used ${tools.length} tools`}
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
