/**
 * AgentMemoryTab — private memory editor for the agent detail page.
 * Reuses useAgentMemory hook from @polpo-ai/react.
 */

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Brain,
  Save,
  Loader2,
  RefreshCw,
  Eye,
  Pencil,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { useAgentMemory } from "@polpo-ai/react";
import { useAgentDetail } from "./agent-detail-provider";
import { toast } from "sonner";

function MemoryStats({ content }: { content: string }) {
  const lines = content.split("\n").length;
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  const chars = content.length;

  return (
    <div className="flex items-center gap-3 text-[10px] text-muted-foreground font-mono">
      <span>{lines} lines</span>
      <span>&middot;</span>
      <span>{words} words</span>
      <span>&middot;</span>
      <span>{chars.toLocaleString()} chars</span>
    </div>
  );
}

export function AgentMemoryTab() {
  const { state: { agent } } = useAgentDetail();
  const { memory, isLoading, error, refetch, saveMemory } = useAgentMemory(agent.name);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<"edit" | "preview">("preview");

  useEffect(() => {
    if (memory) {
      setContent(memory.content);
      setDirty(false);
    }
  }, [memory]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveMemory(content);
      setDirty(false);
      toast.success(`Memory for "${agent.name}" saved`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
        <Brain className="h-10 w-10 opacity-40 text-destructive" />
        <p className="text-sm font-medium">Failed to load memory</p>
        <p className="text-xs text-destructive">{error.message}</p>
        <Button variant="outline" size="sm" onClick={refetch}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <Card className="flex flex-col flex-1 min-h-0 overflow-hidden bg-card/80 backdrop-blur-sm border-border/40">
      <CardHeader className="flex flex-row items-center justify-between pb-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <Brain className="h-4 w-4 text-primary" />
          </div>
          <div>
            <CardTitle className="text-sm">Agent Memory</CardTitle>
            <div className="flex items-center gap-2 mt-0.5">
              {!(memory?.exists) && (
                <Badge variant="secondary" className="text-[10px]">New</Badge>
              )}
              {dirty && (
                <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-500/30">
                  Unsaved changes
                </Badge>
              )}
              {content && <MemoryStats content={content} />}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Tabs value={view} onValueChange={(v) => setView(v as "edit" | "preview")}>
            <TabsList className="h-8">
              <TabsTrigger value="edit" className="text-xs px-2.5 h-6 gap-1">
                <Pencil className="h-3 w-3" /> Edit
              </TabsTrigger>
              <TabsTrigger value="preview" className="text-xs px-2.5 h-6 gap-1">
                <Eye className="h-3 w-3" /> Preview
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="outline" size="sm" onClick={refetch}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!dirty || saving}
            className="gap-1.5"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden">
        {view === "edit" ? (
          <Textarea
            className="h-full min-h-0 font-mono text-sm resize-none bg-input/50 border-border/40 focus:border-primary/50"
            placeholder={`Private memory for "${agent.identity?.displayName ?? agent.name}". Write agent-specific context: preferred patterns, lessons learned, tool preferences, etc.`}
            value={content}
            onChange={(e) => { setContent(e.target.value); setDirty(true); }}
          />
        ) : (
          <ScrollArea className="h-full">
            <div className="pr-4">
              {content ? (
                <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:text-foreground prose-a:text-primary">
                  <MessageResponse>{content}</MessageResponse>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <Brain className="h-10 w-10 mb-3 opacity-40" />
                  <p className="text-sm">No memory content yet</p>
                  <p className="text-xs mt-1">Switch to Edit mode to add agent-specific context</p>
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
