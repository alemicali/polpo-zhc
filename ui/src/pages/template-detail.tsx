import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent } from "@/components/ui/card";
import {
  ArrowLeft,
  Loader2,
  Workflow,
  Hash,
  Asterisk,
  ListChecks,
  FileJson,
  Bot,
} from "lucide-react";
import { ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTemplates } from "@lumea-labs/polpo-react";
import type {
  TemplateDefinition,
  TemplateParameter,
} from "@lumea-labs/polpo-react";
import { toast } from "sonner";
import { JsonBlock } from "@/components/json-block";
import {
  parseMissionData,
  MissionGraphInner,
  TaskStepCard,
} from "@/pages/mission-detail";
import type { MissionTaskDef } from "@/pages/mission-detail";

// ── Parameter detail card ──

function ParamCard({ param }: { param: TemplateParameter }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border/40 bg-card/60 px-3 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <code className="text-xs font-semibold font-mono">{`{{${param.name}}}`}</code>
          {param.required && (
            <Badge variant="outline" className="text-[8px] px-1 py-0 text-rose-400 gap-0.5">
              <Asterisk className="h-2 w-2" />
              required
            </Badge>
          )}
          <Badge variant="secondary" className="text-[8px] px-1 py-0">
            {param.type ?? "string"}
          </Badge>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1">{param.description}</p>
        <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground">
          {param.default !== undefined && (
            <span>Default: <code className="font-mono bg-muted/40 px-1 rounded">{String(param.default)}</code></span>
          )}
          {param.enum && param.enum.length > 0 && (
            <span>Values: {param.enum.map(String).join(", ")}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main page ──

export function TemplateDetailPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const { getTemplate } = useTemplates();

  const [template, setTemplate] = useState<TemplateDefinition | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!name) return;
    setLoading(true);
    getTemplate(name)
      .then(setTemplate)
      .catch((e) => {
        toast.error(`Failed to load template: ${(e as Error).message}`);
        navigate("/templates");
      })
      .finally(() => setLoading(false));
  }, [name, getTemplate, navigate]);

  // Parse the mission body for the graph
  const parsed = useMemo(() => {
    if (!template?.mission) return null;
    return parseMissionData(JSON.stringify(template.mission));
  }, [template]);

  const taskDefs = parsed?.tasks ?? [];
  const checkpoints = parsed?.checkpoints;
  const params = template?.parameters ?? [];
  const requiredParams = params.filter((p) => p.required);

  // No-op: template preview has no live tasks
  const findLiveTask = () => undefined;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!template) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        Template not found
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Header */}
      <div className="flex items-center gap-3 shrink-0">
        <Button variant="ghost" size="sm" onClick={() => navigate("/templates")} className="shrink-0">
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Workflow className="h-5 w-5 text-primary" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold truncate">{template.name}</h1>
            <Badge variant="secondary" className="text-[9px] gap-1 px-1.5 py-0">
              <Hash className="h-2 w-2" />
              {params.length} param{params.length !== 1 ? "s" : ""}
            </Badge>
            {requiredParams.length > 0 && (
              <Badge variant="outline" className="text-[9px] gap-0.5 px-1.5 py-0 text-rose-400">
                <Asterisk className="h-2 w-2" />
                {requiredParams.length} required
              </Badge>
            )}
            <Badge variant="outline" className="text-[9px] gap-1 px-1.5 py-0">
              <ListChecks className="h-2 w-2" />
              {taskDefs.length} task{taskDefs.length !== 1 ? "s" : ""}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{template.description}</p>
        </div>


      </div>

      {/* Tabs */}
      <Tabs defaultValue="graph" className="flex flex-col flex-1 min-h-0">
        <TabsList className="shrink-0">
          <TabsTrigger value="graph" className="gap-1.5 text-xs">
            <Workflow className="h-3.5 w-3.5" />
            Graph
          </TabsTrigger>
          <TabsTrigger value="tasks" className="gap-1.5 text-xs">
            <ListChecks className="h-3.5 w-3.5" />
            Tasks
          </TabsTrigger>
          <TabsTrigger value="parameters" className="gap-1.5 text-xs">
            <Hash className="h-3.5 w-3.5" />
            Parameters
          </TabsTrigger>
          <TabsTrigger value="json" className="gap-1.5 text-xs">
            <FileJson className="h-3.5 w-3.5" />
            Raw JSON
          </TabsTrigger>
        </TabsList>

        {/* Graph tab */}
        <TabsContent value="graph" className="flex-1 min-h-0 mt-0">
          <div className="h-full rounded-lg border border-border/40 overflow-hidden">
            {/* Blueprint banner */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border/30 bg-muted/20">
              <Workflow className="h-3.5 w-3.5 text-primary/60" />
              <span className="text-[11px] text-muted-foreground">
                Template preview — placeholders shown as <code className="text-[10px] bg-muted/50 px-1 rounded">{`{{param}}`}</code>
              </span>
            </div>
            <div className="h-[calc(100%-36px)]">
              <ReactFlowProvider>
                <MissionGraphInner
                  taskDefs={taskDefs}
                  findLiveTask={findLiveTask}
                  checkpoints={checkpoints}
                />
              </ReactFlowProvider>
            </div>
          </div>
        </TabsContent>

        {/* Tasks tab */}
        <TabsContent value="tasks" className="flex-1 min-h-0 mt-0">
          <ScrollArea className="h-full">
            <div className="py-4 pr-4">
              {/* Blueprint banner */}
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border/30 bg-muted/20 mb-4">
                <Workflow className="h-3.5 w-3.5 text-primary/60" />
                <span className="text-[11px] text-muted-foreground">
                  Template blueprint — {taskDefs.length} task{taskDefs.length !== 1 ? "s" : ""} defined
                </span>
              </div>

              {/* Task stepper */}
              <div className="space-y-0">
                {taskDefs.map((td: MissionTaskDef, i: number) => (
                  <TaskStepCard
                    key={i}
                    taskDef={td}
                    index={i}
                    isLast={i === taskDefs.length - 1}
                    navigate={navigate}
                  />
                ))}
              </div>
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Parameters tab */}
        <TabsContent value="parameters" className="flex-1 min-h-0 mt-0">
          <ScrollArea className="h-full">
            <div className="max-w-2xl mx-auto py-4 pr-4 space-y-4">
              {params.length === 0 ? (
                <Card className="bg-card/60 border-border/40">
                  <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Hash className="h-8 w-8 mb-3 text-muted-foreground/30" />
                    <p className="text-sm">This template takes no parameters</p>
                  </CardContent>
                </Card>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      {params.length} parameter{params.length !== 1 ? "s" : ""}{" "}
                      ({requiredParams.length} required)
                    </p>
                  </div>
                  <div className="space-y-2">
                    {params.map((p) => (
                      <ParamCard key={p.name} param={p} />
                    ))}
                  </div>
                </>
              )}

              {/* Team section if volatile team is defined */}
              {template.mission && (template.mission as any).team && Array.isArray((template.mission as any).team) && (
                <div className="mt-6">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">Volatile Team</p>
                  <div className="space-y-2">
                    {((template.mission as any).team as Array<{ name: string; role?: string; model?: string }>).map((member, i) => (
                      <div key={i} className="flex items-center gap-3 rounded-lg border border-border/40 bg-card/60 px-3 py-2">
                        <Bot className="h-4 w-4 text-primary/60 shrink-0" />
                        <div className="min-w-0">
                          <span className="text-xs font-semibold">{member.name}</span>
                          {member.role && <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">{member.role}</p>}
                          {member.model && <code className="text-[9px] font-mono text-muted-foreground/60">{member.model}</code>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Raw JSON tab */}
        <TabsContent value="json" className="flex-1 min-h-0 mt-0">
          <ScrollArea className="h-full">
            <div className="p-4">
              <JsonBlock
                data={template}
                className="text-[11px] leading-relaxed font-mono bg-muted/30 border border-border/20 rounded-lg p-4 whitespace-pre-wrap overflow-x-auto"
              />
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
