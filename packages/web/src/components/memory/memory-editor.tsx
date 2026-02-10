"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useMemory } from "@orchestra/react";
import { Save, RotateCcw, RefreshCw, FileText, Plus } from "lucide-react";
import { toast } from "sonner";

const MEMORY_TEMPLATE = `# Project Memory

## Architecture
<!-- Describe your tech stack, folder structure, key patterns -->

## Conventions
<!-- Coding conventions, naming rules, style guides -->

## Decisions
<!-- Key decisions and why they were made -->

## Notes
<!-- Anything agents should know about this project -->
`;

export function MemoryEditor() {
  const { memory, isLoading, saveMemory, refetch } = useMemory();
  const [content, setContent] = useState("");
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (memory) {
      setContent(memory.content);
      setIsDirty(false);
    }
  }, [memory]);

  const handleSave = useCallback(async () => {
    try {
      await saveMemory(content);
      setIsDirty(false);
      toast.success("Memory saved");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [content, saveMemory]);

  const handleReset = () => {
    if (memory) {
      setContent(memory.content);
      setIsDirty(false);
    }
  };

  const handleInitialize = async () => {
    setContent(MEMORY_TEMPLATE);
    setIsDirty(true);
  };

  const lineCount = content.split("\n").filter((l) => l.trim()).length;
  const charCount = content.length;

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Loading memory...
        </CardContent>
      </Card>
    );
  }

  // Empty state — no memory file yet
  if (memory && !memory.exists && !isDirty) {
    return (
      <Card>
        <CardContent className="py-12 flex flex-col items-center gap-4">
          <FileText className="h-10 w-10 text-muted-foreground/50" />
          <div className="text-center">
            <p className="text-sm font-medium">No project memory yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Memory is injected into every agent&apos;s prompt as shared project context.
            </p>
          </div>
          <Button size="sm" onClick={handleInitialize}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Create Memory
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">MEMORY.md</CardTitle>
              <CardDescription>
                Agents receive this as context with every task
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {isDirty && (
                <Badge variant="outline" className="text-status-running">
                  Unsaved changes
                </Badge>
              )}
              <Badge variant="secondary" className="text-xs tabular-nums">
                {lineCount} lines / {charCount} chars
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            placeholder="# Project Memory&#10;&#10;Notes, context, and instructions for agents..."
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setIsDirty(true);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                if (isDirty) handleSave();
              }
            }}
            rows={24}
            className="font-mono text-xs leading-relaxed resize-y min-h-[200px]"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleSave} disabled={!isDirty}>
              <Save className="mr-1.5 h-3.5 w-3.5" />
              Save
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleReset}
              disabled={!isDirty}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Reset
            </Button>
            <Button variant="ghost" size="sm" onClick={() => refetch()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Refresh
            </Button>
            <span className="flex-1" />
            <span className="text-[10px] text-muted-foreground">
              Ctrl+S to save
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
