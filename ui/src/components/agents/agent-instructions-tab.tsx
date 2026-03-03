/**
 * AgentInstructionsTab — system prompt viewer.
 * Reads data from AgentDetailContext.
 */

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Copy, Eye, EyeOff, Terminal } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { useAgentDetail } from "./agent-detail-provider";

export function AgentInstructionsTab() {
  const { state: { agent } } = useAgentDetail();
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 pr-4 pb-bottom-nav lg:pb-4">
        {agent.systemPrompt ? (
          <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30">
              <span className="text-[10px] text-muted-foreground font-mono">
                {agent.systemPrompt.length.toLocaleString()} chars
              </span>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost" size="sm" className="h-6 w-6 p-0"
                      onClick={() => navigator.clipboard.writeText(agent.systemPrompt!)}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">Copy</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost" size="sm" className="h-6 w-6 p-0"
                      onClick={() => setShowSystemPrompt(!showSystemPrompt)}
                    >
                      {showSystemPrompt ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">{showSystemPrompt ? "Collapse" : "Expand"}</TooltipContent>
                </Tooltip>
              </div>
            </div>
            <div className={cn(
              "px-4 py-3 text-sm overflow-hidden",
              !showSystemPrompt && "max-h-[70vh]"
            )}>
              <MessageResponse>{agent.systemPrompt}</MessageResponse>
            </div>
            {!showSystemPrompt && (
              <div className="h-8 bg-gradient-to-t from-card/95 to-transparent -mt-8 relative pointer-events-none" />
            )}
          </Card>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground max-w-md mx-auto text-center">
            <Terminal className="h-10 w-10 mb-3 opacity-40" />
            <p className="text-sm font-medium">No additional instructions</p>
            <p className="text-xs text-muted-foreground/60 mt-2 leading-relaxed">
              The <code className="font-mono text-[10px]">systemPrompt</code> field lets you add custom instructions that are appended to the agent's built-in prompt.
            </p>
            <p className="text-xs text-muted-foreground/60 mt-2 leading-relaxed">
              The following are injected dynamically from the agent's identity and config — no need to repeat them here:
            </p>
            <div className="flex flex-wrap justify-center gap-1.5 mt-2">
              {["role", "tone", "personality", "bio", "displayName", "title", "responsibilities", "timezone", "language", "model", "allowedTools", "skills"].map(f => (
                <span key={f} className="rounded bg-muted/50 border border-border/30 px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
