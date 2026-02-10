"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { cn } from "@/lib/utils";

export function ExpectationBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    test: "text-cyan-400 border-cyan-400/30 bg-cyan-400/10",
    script: "text-blue-400 border-blue-400/30 bg-blue-400/10",
    file_exists: "text-green-400 border-green-400/30 bg-green-400/10",
    llm_review: "text-purple-400 border-purple-400/30 bg-purple-400/10",
  };
  return (
    <Badge variant="outline" className={cn("text-[10px]", colors[type] ?? "")}>
      {type}
    </Badge>
  );
}

/** Raw YAML code block with copy button — used in plan detail page YAML tab */
export function PlanYamlCode({ yaml }: { yaml: string }) {
  return (
    <div className="relative">
      <CodeBlock code={yaml} language="yaml" showLineNumbers>
        <CodeBlockHeader>
          <CodeBlockTitle>plan.yaml</CodeBlockTitle>
          <CodeBlockCopyButton />
        </CodeBlockHeader>
      </CodeBlock>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HumanReadableView — kept for chat-interface plan preview
// ---------------------------------------------------------------------------

interface ParsedTask {
  title: string;
  description: string;
  assignTo?: string;
  dependsOn?: string[];
  expectations?: Array<{ type: string; threshold?: number }>;
}

interface ParsedTeamMember {
  name: string;
  adapter?: string;
  model?: string;
  role?: string;
  volatile?: boolean;
}

interface ParsedPlan {
  name?: string;
  team?: ParsedTeamMember[];
  tasks: ParsedTask[];
}

function parsePlanYaml(yaml: string): ParsedPlan | null {
  try {
    const lines = yaml.split("\n");
    const plan: ParsedPlan = { tasks: [] };
    let section: "root" | "team" | "tasks" = "root";
    let item: Record<string, unknown> | null = null;
    let sub: string | null = null;
    let subItem: Record<string, unknown> | null = null;

    for (const line of lines) {
      const t = line.trimEnd();
      if (!t || t.startsWith("#")) continue;

      if (/^name:\s*/.test(t)) { plan.name = t.replace(/^name:\s*/, "").replace(/^["']|["']$/g, ""); continue; }
      if (/^team:\s*$/.test(t)) { section = "team"; continue; }
      if (/^tasks:\s*$/.test(t)) { section = "tasks"; continue; }

      if (section === "team" && /^\s{2}- name:/.test(t)) {
        if (item) (plan.team ??= []).push(item as unknown as ParsedTeamMember);
        item = { name: t.replace(/^\s*- name:\s*/, "").replace(/^["']|["']$/g, "") };
        continue;
      }

      if (section === "tasks" && /^\s{2}- title:/.test(t)) {
        if (item) plan.tasks.push(item as unknown as ParsedTask);
        item = { title: t.replace(/^\s*- title:\s*/, "").replace(/^["']|["']$/g, "") };
        sub = null; subItem = null;
        continue;
      }

      if (item && section === "tasks") {
        const m4 = t.match(/^\s{4}(\w+):\s*(.*)$/);
        if (m4 && !t.match(/^\s{4}-/)) {
          const [, key, val] = m4;
          if (key === "expectations" || key === "dependsOn") {
            sub = key;
            if (val) {
              (item as Record<string, unknown>)[key] = val.replace(/[\[\]]/g, "").split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
              sub = null;
            } else { (item as Record<string, unknown>)[key] = []; }
            continue;
          }
          (item as Record<string, unknown>)[key] = val.replace(/^["']|["']$/g, "");
          continue;
        }
        if (sub === "expectations" && /^\s{6}- type:/.test(t)) {
          if (subItem) ((item as Record<string, unknown>).expectations as unknown[]).push(subItem);
          subItem = { type: t.replace(/^\s*- type:\s*/, "").replace(/^["']|["']$/g, "") };
          continue;
        }
        if (sub === "dependsOn" && /^\s{6}-/.test(t)) {
          ((item as Record<string, unknown>).dependsOn as string[]).push(t.replace(/^\s*-\s*/, "").replace(/^["']|["']$/g, ""));
          continue;
        }
        if (subItem) {
          const m8 = t.match(/^\s{8}(\w+):\s*(.*)$/);
          if (m8) (subItem as Record<string, unknown>)[m8[1]] = m8[2].replace(/^["']|["']$/g, "");
        }
      }

      if (item && section === "team") {
        const m4 = t.match(/^\s{4}(\w+):\s*(.*)$/);
        if (m4) (item as Record<string, unknown>)[m4[1]] = m4[2] === "true" ? true : m4[2].replace(/^["']|["']$/g, "");
      }
    }

    if (subItem && item && section === "tasks") ((item as Record<string, unknown>).expectations as unknown[])?.push(subItem);
    if (item) {
      if (section === "team") (plan.team ??= []).push(item as unknown as ParsedTeamMember);
      if (section === "tasks") plan.tasks.push(item as unknown as ParsedTask);
    }
    return plan;
  } catch { return null; }
}

export function HumanReadableView({ yaml }: { yaml: string }) {
  const parsed = useMemo(() => parsePlanYaml(yaml), [yaml]);
  if (!parsed) return <p className="text-sm text-muted-foreground p-4">Could not parse plan YAML</p>;

  return (
    <div className="space-y-6 p-4">
      {parsed.team && parsed.team.length > 0 && (
        <div>
          <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
            Team ({parsed.team.length} agents)
          </h4>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {parsed.team.map((m) => (
              <div key={m.name} className="rounded-md border bg-muted/20 p-2.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{m.name}</span>
                  {m.volatile && <Badge variant="outline" className="text-[9px] h-4">volatile</Badge>}
                </div>
                {m.role && <p className="text-muted-foreground mt-0.5">{m.role}</p>}
                <div className="flex gap-2 mt-1 text-muted-foreground/60">
                  {m.adapter && <span>{m.adapter}</span>}
                  {m.model && <span>· {m.model}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
          Tasks ({parsed.tasks.length})
        </h4>
        <div className="space-y-3">
          {parsed.tasks.map((task, i) => (
            <div key={task.title} className="rounded-md border bg-muted/20 p-3">
              <div className="flex items-start gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{task.title}</span>
                    {task.assignTo && <Badge variant="outline" className="text-[10px] h-4">→ {task.assignTo}</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap line-clamp-3">{task.description}</p>
                  {task.dependsOn && task.dependsOn.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-2">
                      <span className="text-[10px] text-muted-foreground/60">depends on:</span>
                      {task.dependsOn.map((dep) => (
                        <Badge key={dep} variant="outline" className="text-[9px] h-4 font-mono">{dep}</Badge>
                      ))}
                    </div>
                  )}
                  {task.expectations && task.expectations.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                      <span className="text-[10px] text-muted-foreground/60">checks:</span>
                      {task.expectations.map((exp, j) => <ExpectationBadge key={j} type={exp.type} />)}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
