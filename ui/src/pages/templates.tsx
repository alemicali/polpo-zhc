import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Workflow,
  Play,
  Search,
  Loader2,
  RefreshCw,
  Settings2,
  FolderOpen,
  Hash,
  Asterisk,

} from "lucide-react";
import { useTemplates } from "@polpo-ai/react";
import type {
  TemplateInfo,
  TemplateParameter,
} from "@polpo-ai/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ── Parameter type badge colors ──

const paramTypeColor: Record<string, string> = {
  string: "text-primary",
  number: "text-primary/80",
  boolean: "text-primary/60",
};

// ── Parameter input field ──

function ParamField({
  param,
  value,
  onChange,
}: {
  param: TemplateParameter;
  value: string;
  onChange: (v: string) => void;
}) {
  // Enum → select
  if (param.enum && param.enum.length > 0) {
    return (
      <div>
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
          {param.name}
          {param.required && <Asterisk className="h-2 w-2 text-rose-400" />}
        </label>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="h-8 text-sm bg-input/50">
            <SelectValue placeholder={`Select ${param.name}...`} />
          </SelectTrigger>
          <SelectContent>
            {param.enum.map((v) => (
              <SelectItem key={String(v)} value={String(v)}>
                {String(v)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {param.description && (
          <p className="text-[10px] text-muted-foreground mt-0.5">{param.description}</p>
        )}
      </div>
    );
  }

  // Boolean → select true/false
  if (param.type === "boolean") {
    return (
      <div>
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
          {param.name}
          {param.required && <Asterisk className="h-2 w-2 text-rose-400" />}
        </label>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="h-8 text-sm bg-input/50">
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">true</SelectItem>
            <SelectItem value="false">false</SelectItem>
          </SelectContent>
        </Select>
        {param.description && (
          <p className="text-[10px] text-muted-foreground mt-0.5">{param.description}</p>
        )}
      </div>
    );
  }

  // Default → text input
  return (
    <div>
      <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
        {param.name}
        {param.required && <Asterisk className="h-2 w-2 text-rose-400" />}
      </label>
      <Input
        className="h-8 text-sm font-mono bg-input/50"
        type={param.type === "number" ? "number" : "text"}
        placeholder={
          param.default !== undefined
            ? `Default: ${param.default}`
            : param.description || param.name
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {param.description && (
        <p className="text-[10px] text-muted-foreground mt-0.5">{param.description}</p>
      )}
    </div>
  );
}

// ── Run template dialog ──

function RunTemplateDialog({
  template,
  open,
  onOpenChange,
  onRun,
}: {
  template: TemplateInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRun: (name: string, params: Record<string, string | number | boolean>) => Promise<void>;
}) {
  const params = template.parameters ?? [];
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of params) {
      if (p.default !== undefined) init[p.name] = String(p.default);
      else init[p.name] = "";
    }
    return init;
  });
  const [running, setRunning] = useState(false);

  const setValue = (name: string, val: string) => {
    setValues((prev) => ({ ...prev, [name]: val }));
  };

  // Validate required params are filled
  const missingRequired = params.filter(
    (p) => p.required && !values[p.name]?.trim()
  );

  const handleRun = async () => {
    setRunning(true);
    try {
      // Convert values to proper types
      const resolved: Record<string, string | number | boolean> = {};
      for (const p of params) {
        const raw = values[p.name];
        if (!raw && !p.required) continue; // skip empty optional params
        if (p.type === "number") resolved[p.name] = Number(raw);
        else if (p.type === "boolean") resolved[p.name] = raw === "true";
        else resolved[p.name] = raw;
      }
      await onRun(template.name, resolved);
      onOpenChange(false);
    } catch {
      // error handled by caller
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto bg-popover/95 backdrop-blur-xl border-border/40">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Play className="h-4 w-4 text-teal-400" />
            Run "{template.name}"
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">{template.description}</p>

        {params.length === 0 ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Settings2 className="h-4 w-4" />
            This template takes no parameters
          </div>
        ) : (
          <div className="space-y-3 pt-2">
            {params.map((p) => (
              <ParamField
                key={p.name}
                param={p}
                value={values[p.name] ?? ""}
                onChange={(v) => setValue(p.name, v)}
              />
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 justify-end pt-2">
          {missingRequired.length > 0 && (
            <span className="text-[10px] text-rose-400 mr-auto">
              {missingRequired.length} required param{missingRequired.length > 1 ? "s" : ""} missing
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={running}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="gap-1.5 bg-teal-600 hover:bg-teal-700 text-white"
            onClick={handleRun}
            disabled={missingRequired.length > 0 || running}
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Run Template
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}



// ── Template card ──

function TemplateCard({
  template,
  onClick,
}: {
  template: TemplateInfo;
  onClick: () => void;
}) {
  const params = template.parameters ?? [];
  const requiredParams = params.filter((p) => p.required);

  return (
    <Card
      className="group transition-all py-0 bg-card/80 backdrop-blur-sm border-border/40 hover:border-primary/20 hover:shadow-[0_0_15px_oklch(0.7_0.15_200_/_8%)] cursor-pointer"
      onClick={onClick}
    >
      <CardContent className="px-4 py-3">
        <div className="flex items-start gap-3">
          {/* Icon */}
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Workflow className="h-5 w-5 text-primary" />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{template.name}</span>
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
            </div>
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
              {template.description}
            </p>

            {/* Parameter tags */}
            {params.length > 0 && (
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                {params.map((p) => (
                  <Tooltip key={p.name}>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[9px] font-mono px-1.5 py-0 gap-0.5 cursor-help",
                          paramTypeColor[p.type ?? "string"] ?? "text-muted-foreground"
                        )}
                      >
                        {p.required && <Asterisk className="h-1.5 w-1.5 text-rose-400" />}
                        {p.name}
                        {p.default !== undefined && (
                          <span className="text-muted-foreground/60">={String(p.default)}</span>
                        )}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent className="text-xs max-w-xs">
                      <p className="font-medium">{p.name}</p>
                      <p className="text-muted-foreground">{p.description}</p>
                      <p className="font-mono text-[10px] mt-0.5">
                        type: {p.type ?? "string"}
                        {p.required && " (required)"}
                        {p.enum && ` | values: ${p.enum.join(", ")}`}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            )}

            {/* Path */}
            <div className="flex items-center gap-1 mt-2">
              <FolderOpen className="h-2.5 w-2.5 text-muted-foreground/50" />
              <span className="text-[9px] font-mono text-muted-foreground/50 truncate">
                {template.path}
              </span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main page ──

export function TemplatesPage() {
  const navigate = useNavigate();
  const { templates, loading, refetch, runTemplate } = useTemplates();
  const [search, setSearch] = useState("");

  // Run dialog state
  const [runTarget, setRunTarget] = useState<TemplateInfo | null>(null);

  const filtered = useMemo(() => {
    if (!search) return templates;
    const q = search.toLowerCase();
    return templates.filter(
      (w) =>
        w.name.toLowerCase().includes(q) ||
        w.description.toLowerCase().includes(q) ||
        w.parameters.some((p) => p.name.toLowerCase().includes(q))
    );
  }, [templates, search]);

  const handleRun = async (
    name: string,
    params: Record<string, string | number | boolean>
  ) => {
    try {
      const result = await runTemplate(name, params);
      toast.success(
        `Template "${name}" started — ${result.tasks} task${result.tasks !== 1 ? "s" : ""} created`
      );
      // Navigate to the created mission
      navigate(`/missions/${result.mission.id}`);
    } catch (e) {
      toast.error(`Run failed: ${(e as Error).message}`);
      throw e; // re-throw so dialog stays open
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search templates..."
            className="pl-9 h-8 text-sm bg-input/50 border-border/40"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="flex-1" />

        <Badge variant="secondary" className="text-xs shrink-0">
          {filtered.length} template{filtered.length !== 1 ? "s" : ""}
        </Badge>

        <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={refetch}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Template list */}
      {filtered.length === 0 ? (
        <Card className="flex-1 bg-card/60 border-border/40">
          <CardContent className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Workflow className="h-12 w-12 mb-4 text-primary/30" />
            <p className="text-sm font-medium">
              {templates.length === 0
                ? "No templates found"
                : "No matching templates"}
            </p>
            <p className="text-xs mt-1 text-center max-w-sm">
              {templates.length === 0 ? (
                <>
                  Templates are parameterized mission definitions.
                  Create a <code className="text-[10px] bg-muted rounded px-1">.polpo/templates/my-template/template.json</code> file to get started.
                </>
              ) : (
                "Try adjusting your search"
              )}
            </p>
          </CardContent>
        </Card>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-2 pr-4">
            {filtered.map((w) => (
              <TemplateCard
                key={w.name}
                template={w}
                onClick={() => navigate(`/templates/${encodeURIComponent(w.name)}`)}
              />
            ))}
          </div>
        </ScrollArea>
      )}

      {/* Run dialog */}
      {runTarget && (
        <RunTemplateDialog
          template={runTarget}
          open={true}
          onOpenChange={(open) => { if (!open) setRunTarget(null); }}
          onRun={handleRun}
        />
      )}

    </div>
  );
}
