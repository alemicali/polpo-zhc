import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Brain,
  Save,
  Loader2,
  RefreshCw,
  Eye,
  Pencil,
  User,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { useMemory, useAgentMemory, useAgents } from "@polpo-ai/react";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";

// ── Memory stats ──

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

// ── Shared Memory Editor ──

function SharedMemoryEditor() {
  const { memory, isLoading: loading, error, refetch, saveMemory } = useMemory();
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [memoryView, setMemoryView] = useState<"edit" | "preview">("preview");

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
      toast.success("Shared memory saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
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
    <MemoryEditorUI
      title="Shared Memory"
      content={content}
      dirty={dirty}
      saving={saving}
      memoryView={memoryView}
      exists={memory?.exists ?? false}
      onContentChange={(v) => { setContent(v); setDirty(true); }}
      onSave={handleSave}
      onRefetch={refetch}
      onViewChange={setMemoryView}
      placeholder="Shared memory is context that all agents and the orchestrator can reference. Write markdown here — conventions, architecture notes, key decisions, etc."
    />
  );
}

// ── Agent Memory Editor ──

function AgentMemoryEditor({ agentName }: { agentName: string }) {
  const { memory, isLoading: loading, error, refetch, saveMemory } = useAgentMemory(agentName);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [memoryView, setMemoryView] = useState<"edit" | "preview">("preview");

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
      toast.success(`Memory for "${agentName}" saved`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
        <User className="h-10 w-10 opacity-40 text-destructive" />
        <p className="text-sm font-medium">Failed to load agent memory</p>
        <p className="text-xs text-destructive">{error.message}</p>
        <Button variant="outline" size="sm" onClick={refetch}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <MemoryEditorUI
      title={`Agent Memory: ${agentName}`}
      content={content}
      dirty={dirty}
      saving={saving}
      memoryView={memoryView}
      exists={memory?.exists ?? false}
      onContentChange={(v) => { setContent(v); setDirty(true); }}
      onSave={handleSave}
      onRefetch={refetch}
      onViewChange={setMemoryView}
      placeholder={`Private memory for agent "${agentName}". Write agent-specific context: preferred patterns, lessons learned, tool preferences, etc.`}
    />
  );
}

// ── Reusable Memory Editor UI ──

function MemoryEditorUI({
  title,
  content,
  dirty,
  saving,
  memoryView,
  exists,
  onContentChange,
  onSave,
  onRefetch,
  onViewChange,
  placeholder,
}: {
  title: string;
  content: string;
  dirty: boolean;
  saving: boolean;
  memoryView: "edit" | "preview";
  exists: boolean;
  onContentChange: (v: string) => void;
  onSave: () => void;
  onRefetch: () => void;
  onViewChange: (v: "edit" | "preview") => void;
  placeholder: string;
}) {
  return (
    <>
      <CardHeader className="flex flex-row items-center justify-between pb-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <Brain className="h-4 w-4 text-primary" />
          </div>
          <div>
            <CardTitle className="text-sm">{title}</CardTitle>
            <div className="flex items-center gap-2 mt-0.5">
              {!exists && (
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
          <Tabs value={memoryView} onValueChange={(v) => onViewChange(v as "edit" | "preview")}>
            <TabsList className="h-8">
              <TabsTrigger value="edit" className="text-xs px-2.5 h-6 gap-1">
                <Pencil className="h-3 w-3" /> Edit
              </TabsTrigger>
              <TabsTrigger value="preview" className="text-xs px-2.5 h-6 gap-1">
                <Eye className="h-3 w-3" /> Preview
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="outline" size="sm" onClick={onRefetch}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            onClick={onSave}
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
        {memoryView === "edit" ? (
          <Textarea
            className="h-full min-h-0 font-mono text-sm resize-none bg-input/50 border-border/40 focus:border-primary/50"
            placeholder={placeholder}
            value={content}
            onChange={(e) => onContentChange(e.target.value)}
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
                  <p className="text-xs mt-1">Switch to Edit mode to add context</p>
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </>
  );
}

// ── Main page ──

export function MemoryPage() {
  const { agents } = useAgents();
  const [scope, setScope] = useState<string>("shared");

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Card className="flex flex-col h-full overflow-hidden bg-card/80 backdrop-blur-sm border-border/40">
        {/* Scope selector */}
        <div className="flex items-center gap-3 px-6 pt-4 pb-0 shrink-0">
          <span className="text-xs text-muted-foreground font-medium">Scope:</span>
          <Select value={scope} onValueChange={setScope}>
            <SelectTrigger className="w-[200px] h-8 text-xs">
              <SelectValue placeholder="Select scope" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="shared">
                <div className="flex items-center gap-2">
                  <Brain className="h-3.5 w-3.5" />
                  Shared Memory
                </div>
              </SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.name} value={`agent:${agent.name}`}>
                  <div className="flex items-center gap-2">
                    <User className="h-3.5 w-3.5" />
                    {agent.name}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Memory editor based on scope */}
        {scope === "shared" ? (
          <SharedMemoryEditor />
        ) : (
          <AgentMemoryEditor agentName={scope.replace("agent:", "")} />
        )}
      </Card>
    </div>
  );
}
