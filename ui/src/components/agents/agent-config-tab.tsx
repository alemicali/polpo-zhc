/**
 * AgentConfigTab — raw JSON config viewer.
 * Reads data from AgentDetailContext.
 */

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Copy } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { useAgentDetail } from "./agent-detail-provider";

export function AgentConfigTab() {
  const { state: { agent } } = useAgentDetail();

  return (
    <ScrollArea className="h-full">
      <div className="pr-4 pb-bottom-nav lg:pb-4">
        <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30">
            <span className="text-[10px] text-muted-foreground font-mono">polpo.json &mdash; agent configuration</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost" size="sm" className="h-6 w-6 p-0"
                  onClick={() => navigator.clipboard.writeText(JSON.stringify(agent, null, 2))}
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Copy JSON</TooltipContent>
            </Tooltip>
          </div>
          <div className="px-4 py-3 text-xs leading-relaxed overflow-x-auto">
            <MessageResponse>{"```json\n" + JSON.stringify(agent, null, 2) + "\n```"}</MessageResponse>
          </div>
        </Card>
      </div>
    </ScrollArea>
  );
}
