"use client";

import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { useOrchestra, useAgents } from "@orchestra/react";
import {
  Sparkles,
  Play,
  MessageSquare,
  Code2,
  BookOpen,
  ArrowLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type Step = "prompt" | "loading" | "preview" | "refine";
type ViewMode = "readable" | "yaml";

interface ParsedAgent {
  name: string;
  adapter?: string;
  model?: string;
  role?: string;
  systemPrompt?: string;
  skills?: string[];
}

function parseTeamYaml(yaml: string): ParsedAgent[] {
  try {
    const agents: ParsedAgent[] = [];
    const lines = yaml.split("\n");
    let current: Record<string, unknown> | null = null;
    let inSystemPrompt = false;
    let systemPromptLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trimEnd();

      if (/^\s{2}- name:\s*/.test(trimmed)) {
        if (current) {
          if (systemPromptLines.length) current.systemPrompt = systemPromptLines.join("\n");
          agents.push(current as unknown as ParsedAgent);
        }
        current = { name: trimmed.replace(/^\s*- name:\s*/, "").replace(/^["']|["']$/g, "") };
        inSystemPrompt = false;
        systemPromptLines = [];
        continue;
      }

      if (current) {
        if (inSystemPrompt) {
          if (/^\s{4}\w+:/.test(trimmed) && !/^\s{6}/.test(trimmed)) {
            inSystemPrompt = false;
            current.systemPrompt = systemPromptLines.join("\n");
            systemPromptLines = [];
          } else {
            systemPromptLines.push(trimmed.replace(/^\s{6}/, ""));
            continue;
          }
        }

        const match = trimmed.match(/^\s{4}(\w+):\s*(.*)$/);
        if (match) {
          const [, key, val] = match;
          if (key === "systemPrompt" && (val === "|" || val === ">" || !val)) {
            inSystemPrompt = true;
            continue;
          }
          if (key === "skills") {
            current.skills = [];
            continue;
          }
          (current as Record<string, unknown>)[key] = val.replace(/^["']|["']$/g, "");
        }

        if (/^\s{6}-\s+/.test(trimmed) && current.skills) {
          (current.skills as string[]).push(trimmed.replace(/^\s*-\s*/, "").replace(/^["']|["']$/g, ""));
        }
      }
    }

    if (current) {
      if (systemPromptLines.length) current.systemPrompt = systemPromptLines.join("\n");
      agents.push(current as unknown as ParsedAgent);
    }

    return agents;
  } catch {
    return [];
  }
}

function TeamReadableView({ yaml }: { yaml: string }) {
  const agents = parseTeamYaml(yaml);

  if (agents.length === 0) {
    return <p className="text-sm text-muted-foreground p-4">Could not parse team YAML</p>;
  }

  return (
    <div className="space-y-3 p-4">
      <div className="text-xs text-muted-foreground font-medium">
        {agents.length} agent{agents.length !== 1 ? "s" : ""}
      </div>
      {agents.map((agent) => (
        <div key={agent.name} className="rounded-md border bg-muted/20 p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{agent.name}</span>
            <Badge variant="outline" className="text-[10px]">
              {agent.adapter || "claude-sdk"}
            </Badge>
            {agent.model && (
              <span className="text-[10px] text-muted-foreground font-mono">
                {agent.model.replace("claude-", "").replace(/-\d{8}$/, "")}
              </span>
            )}
          </div>
          {agent.role && (
            <p className="text-xs text-muted-foreground mt-1">{agent.role}</p>
          )}
          {agent.skills && agent.skills.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {agent.skills.map((s) => (
                <Badge key={s} variant="outline" className="text-[9px] bg-primary/5">
                  {s}
                </Badge>
              ))}
            </div>
          )}
          {agent.systemPrompt && (
            <details className="mt-2">
              <summary className="text-[10px] text-muted-foreground/60 cursor-pointer hover:text-muted-foreground">
                System prompt
              </summary>
              <pre className="mt-1 text-[10px] text-muted-foreground whitespace-pre-wrap font-mono bg-muted/30 rounded p-2 max-h-32 overflow-y-auto">
                {agent.systemPrompt}
              </pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

export function TeamGenerateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { client } = useOrchestra();
  const { addAgent } = useAgents();
  const [step, setStep] = useState<Step>("prompt");
  const [description, setDescription] = useState("");
  const [yaml, setYaml] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("readable");
  const [feedback, setFeedback] = useState("");

  const reset = useCallback(() => {
    setStep("prompt");
    setDescription("");
    setYaml("");
    setViewMode("readable");
    setFeedback("");
  }, []);

  const handleClose = useCallback((open: boolean) => {
    if (!open) reset();
    onOpenChange(open);
  }, [onOpenChange, reset]);

  const handleGenerate = useCallback(async () => {
    if (!description.trim()) return;
    setStep("loading");
    try {
      const result = await client.generateTeam(description);
      setYaml(result.yaml);
      setStep("preview");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate team");
      setStep("prompt");
    }
  }, [client, description]);

  const handleRefine = useCallback(async () => {
    if (!feedback.trim()) return;
    setStep("loading");
    try {
      const result = await client.refineTeam(yaml, description, feedback);
      setYaml(result.yaml);
      setFeedback("");
      setStep("preview");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to refine team");
      setStep("preview");
    }
  }, [client, yaml, description, feedback]);

  const handleApply = useCallback(async () => {
    const agents = parseTeamYaml(yaml);
    if (agents.length === 0) {
      toast.error("Could not parse team YAML");
      return;
    }

    let added = 0;
    for (const agent of agents) {
      try {
        await addAgent({
          name: agent.name,
          adapter: agent.adapter || "claude-sdk",
          model: agent.model,
          role: agent.role,
          systemPrompt: agent.systemPrompt,
        });
        added++;
      } catch {
        // Agent might already exist — skip
      }
    }

    toast.success(`Team applied: ${added} agent${added !== 1 ? "s" : ""} added`);
    handleClose(false);
  }, [yaml, addAgent, handleClose]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Generate Team with AI
          </DialogTitle>
          <DialogDescription>
            Describe what you need and AI will design a team of specialized agents.
          </DialogDescription>
        </DialogHeader>

        {/* ── Prompt step ── */}
        {step === "prompt" && (
          <div className="space-y-4 mt-2">
            <Textarea
              placeholder="e.g. A fullstack team for a React + Node.js ecommerce project with testing..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleGenerate();
                }
              }}
            />
            <div className="flex justify-between items-center">
              <span className="text-[10px] text-muted-foreground">Ctrl+Enter to generate</span>
              <Button onClick={handleGenerate} disabled={!description.trim()}>
                <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Generate
              </Button>
            </div>
          </div>
        )}

        {/* ── Loading step ── */}
        {step === "loading" && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Shimmer className="w-48 h-4">Designing team…</Shimmer>
            <p className="text-xs text-muted-foreground">
              AI is searching for skills, choosing models, and designing agent roles
            </p>
          </div>
        )}

        {/* ── Preview step ── */}
        {step === "preview" && (
          <div className="space-y-4 mt-2">
            <div className="rounded-lg border overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30">
                <span className="text-xs text-muted-foreground font-medium">Team Preview</span>
                <div className="flex rounded-md border bg-muted/50">
                  <button
                    type="button"
                    className={cn("h-6 px-2 text-[10px] rounded-l-md transition-colors", viewMode === "readable" && "bg-background shadow-sm")}
                    onClick={() => setViewMode("readable")}
                  >
                    <BookOpen className="inline mr-1 h-3 w-3" />Readable
                  </button>
                  <button
                    type="button"
                    className={cn("h-6 px-2 text-[10px] rounded-r-md transition-colors", viewMode === "yaml" && "bg-background shadow-sm")}
                    onClick={() => setViewMode("yaml")}
                  >
                    <Code2 className="inline mr-1 h-3 w-3" />YAML
                  </button>
                </div>
              </div>
              {viewMode === "readable" ? (
                <TeamReadableView yaml={yaml} />
              ) : (
                <CodeBlock code={yaml} language="yaml" showLineNumbers>
                  <CodeBlockHeader>
                    <CodeBlockTitle>team.yaml</CodeBlockTitle>
                    <CodeBlockCopyButton />
                  </CodeBlockHeader>
                </CodeBlock>
              )}
            </div>

            <div className="flex gap-2">
              <Button onClick={handleApply}>
                <Play className="mr-1.5 h-3.5 w-3.5" /> Apply Team
              </Button>
              <Button variant="outline" onClick={() => setStep("refine")}>
                <MessageSquare className="mr-1.5 h-3.5 w-3.5" /> Refine
              </Button>
              <Button variant="ghost" onClick={reset}>
                <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Start Over
              </Button>
            </div>
          </div>
        )}

        {/* ── Refine step ── */}
        {step === "refine" && (
          <div className="space-y-4 mt-2">
            <div className="rounded-lg border bg-muted/10 p-3">
              <TeamReadableView yaml={yaml} />
            </div>
            <Textarea
              placeholder="e.g. Add a DevOps agent, use Opus for the architect, remove the testing agent..."
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={3}
              className="text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleRefine();
                }
              }}
            />
            <div className="flex gap-2">
              <Button onClick={handleRefine} disabled={!feedback.trim()}>
                <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Refine
              </Button>
              <Button variant="ghost" onClick={() => setStep("preview")}>
                <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Back
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
