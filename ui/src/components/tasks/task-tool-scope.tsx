/**
 * Task page → "Tools for this task": the task's optional tool scope (Task.toolScope).
 *
 * "Inherit from agent" (the default: no scope, the task gets everything its agent has) or
 * "Restrict": the connectors (each account is its own connector) the agent has that this task may
 * use, optionally only some of their tools (search, select all / none), and optionally only some
 * of its built-in tools. It only narrows: the editor offers only what the agent has, and the
 * server rejects anything else. Saved with PATCH /tasks/:id { toolScope } (null = inherit).
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Search, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SegmentedControl, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { connectorsApi, filterConnectorTools, toolLabel, type AgentConnectorTools, type Connector, type ConnectorTool } from "@/lib/connectors-api";
import {
  agentBuiltinTools, agentConnectorSelection, agentConnectors, connectorScopeName, describeToolScope, draftFromScope, draftProblems,
  scopeFromDraft, type TaskToolScope, type ToolScopeDraft,
} from "@/lib/task-tool-scope";
import { cn } from "@/lib/utils";

export interface ScopeAgent {
  name: string;
  allowedTools?: string[];
  connectorTools?: AgentConnectorTools;
}

/** The connectors of the workspace (empty when they cannot be read). */
function useConnectors(): { connectors: Connector[]; loading: boolean } {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    connectorsApi.list().then(
      (list) => { if (!cancelled) { setConnectors(list); setLoading(false); } },
      () => { if (!cancelled) setLoading(false); },
    );
    return () => { cancelled = true; };
  }, []);
  return { connectors, loading };
}

export function TaskToolScopeCard({
  scope, stale, agent, onSave,
}: {
  scope: TaskToolScope | undefined;
  /** GET /tasks/:id toolScopeStale: what of the scope the agent no longer has. */
  stale?: string[];
  agent: ScopeAgent | undefined;
  onSave: (scope: TaskToolScope | null) => Promise<unknown>;
}) {
  const { connectors } = useConnectors();
  const [open, setOpen] = useState(false);
  const summary = describeToolScope(scope, connectors);
  return (
    <div data-testid="task-tool-scope" className="shrink-0 space-y-1.5">
      {/* one quiet line: inherited by default, a chip when restricted */}
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Wrench className="h-3 w-3 shrink-0" />
        <span className="shrink-0">Tools:</span>
        {scope ? (
          <Badge variant="secondary" className="h-5 max-w-full truncate px-1.5 text-micro" title={summary} data-testid="task-tool-scope-badge">
            {summary}
          </Badge>
        ) : (
          <span className="truncate" title={summary} data-testid="task-tool-scope-badge">{summary}</span>
        )}
        <Button
          variant="link"
          size="sm"
          className="h-auto shrink-0 p-0 text-xs"
          disabled={!agent}
          onClick={() => setOpen(true)}
        >
          {scope ? "Edit" : "Restrict"}
        </Button>
      </div>
      {stale && stale.length > 0 && (
        <div className="space-y-0.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5" data-testid="task-tool-scope-stale">
          <p className="flex items-center gap-1 text-xs text-warning">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            {agent?.name ?? "The agent"} no longer has part of this scope; the run gets only what is still there:
          </p>
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            {stale.map((s) => <li key={s}>{s}</li>)}
          </ul>
        </div>
      )}
      {open && agent && (
        <TaskToolScopeDialog
          open={open}
          onOpenChange={setOpen}
          agent={agent}
          connectors={connectors}
          scope={scope}
          onSave={onSave}
        />
      )}
    </div>
  );
}

export function TaskToolScopeDialog({
  open, onOpenChange, agent, connectors, scope, onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: ScopeAgent;
  connectors: Connector[];
  scope: TaskToolScope | undefined;
  onSave: (scope: TaskToolScope | null) => Promise<unknown>;
}) {
  const available = useMemo(() => agentConnectors(connectors, agent), [connectors, agent]);
  const [draft, setDraft] = useState<ToolScopeDraft>(() => draftFromScope(scope, available));
  const [saving, setSaving] = useState(false);
  const builtin = agentBuiltinTools(agent);
  const problems = draftProblems(draft);

  const setConnector = (id: string, entry: "*" | string[] | undefined) => setDraft((d) => {
    const next = { ...d.connectors };
    if (entry === undefined) delete next[id]; else next[id] = entry;
    return { ...d, connectors: next };
  });

  const save = async () => {
    setSaving(true);
    try {
      const next = scopeFromDraft(draft);
      await onSave(next);
      toast.success(next ? `Tools restricted for this task` : `This task uses every tool ${agent.name} has`);
      onOpenChange(false);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-xl" data-testid="task-tool-scope-dialog">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Tools for this task</DialogTitle>
          <DialogDescription>
            By default the task gets every tool {agent.name} has. Restrict it to make the run more predictable: it can only narrow what {agent.name} has.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <SegmentedControl
            size="sm"
            aria-label="Tools for this task"
            value={draft.mode}
            onValueChange={(mode: ToolScopeDraft["mode"]) => setDraft((d) => (
              // the first time "Restrict" starts from everything the agent has
              mode === "restrict" && d.mode === "inherit" && Object.keys(d.connectors).length === 0
                ? { ...d, mode, connectors: Object.fromEntries(available.map((c) => [c.id, "*" as const])) }
                : { ...d, mode }
            ))}
          >
            <ToggleGroupItem value="inherit" aria-label="Inherit from agent">Inherit from agent</ToggleGroupItem>
            <ToggleGroupItem value="restrict" aria-label="Restrict">Restrict</ToggleGroupItem>
          </SegmentedControl>

          {draft.mode === "inherit" ? (
            <p className="text-sm text-muted-foreground">Every connector and tool {agent.name} has, now and later.</p>
          ) : (
            <>
              <section className="space-y-2">
                <h4 className="text-sm font-medium">Connectors</h4>
                {available.length === 0 && <p className="text-xs text-muted-foreground">{agent.name} has no connectors.</p>}
                <ul className="space-y-1.5">
                  {available.map((c) => (
                    <ConnectorScopeRow
                      key={c.id}
                      connector={c}
                      agentSelection={agentConnectorSelection(agent, c.id)}
                      entry={draft.connectors[c.id]}
                      onChange={(entry) => setConnector(c.id, entry)}
                    />
                  ))}
                </ul>
              </section>

              <section className="space-y-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={draft.builtin !== null}
                    aria-label="Only some built-in tools"
                    onChange={(e) => setDraft((d) => ({ ...d, builtin: e.target.checked ? [...builtin] : null }))}
                  />
                  Only some built-in tools
                </label>
                {draft.builtin === null ? (
                  <p className="text-xs text-muted-foreground">Built-in tools: as {agent.name} ({builtin.join(", ") || "none"}).</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5" data-testid="task-tool-scope-builtin">
                    {builtin.map((t) => {
                      const on = draft.builtin!.includes(t);
                      return (
                        <label key={t} className={cn("flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs", on ? "border-primary/40 bg-primary/5" : "border-border/40")}>
                          <input
                            type="checkbox"
                            className="accent-primary"
                            checked={on}
                            aria-label={t}
                            onChange={(e) => setDraft((d) => ({ ...d, builtin: e.target.checked ? [...new Set([...(d.builtin ?? []), t])] : (d.builtin ?? []).filter((x) => x !== t) }))}
                          />
                          {t}
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          )}

          {problems.length > 0 && (
            <ul className="space-y-0.5 text-xs text-destructive" data-testid="task-tool-scope-problems">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}

          <DialogFooter sticky>
            <Button variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button disabled={saving || problems.length > 0} onClick={() => void save()}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
            </Button>
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** One connector the agent has: use it or not; all of the agent's tools of it, or only some. */
function ConnectorScopeRow({
  connector, agentSelection, entry, onChange,
}: {
  connector: Connector;
  /** What the agent itself gets of this connector: "*" or the names. */
  agentSelection: "*" | string[];
  /** In the draft: undefined (not used), "*" or the picked names. */
  entry: "*" | string[] | undefined;
  onChange: (entry: "*" | string[] | undefined) => void;
}) {
  const used = entry !== undefined;
  const [tools, setTools] = useState<ConnectorTool[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const wantsList = Array.isArray(entry);

  useEffect(() => {
    if (!wantsList || tools) return;
    let cancelled = false;
    connectorsApi.tools(connector.id).then(
      (list) => { if (!cancelled) setTools(list); },
      (reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { cancelled = true; };
  }, [wantsList, tools, connector.id]);

  // only what the agent gets: its own selection, minus tools turned off for everyone
  const offered = useMemo(() => (tools ?? []).filter((t) => (connector.toolPolicy?.[t.name] ?? t.policy ?? "allow") !== "off"
    && (agentSelection === "*" || agentSelection.includes(t.name))), [tools, connector.toolPolicy, agentSelection]);
  const visible = useMemo(() => filterConnectorTools(offered, query), [offered, query]);
  const picked = Array.isArray(entry) ? entry : [];
  const name = connectorScopeName(connector, connector.id);

  return (
    <li className="rounded-md border border-border/40" data-testid={`task-tool-scope-connector-${connector.id}`}>
      <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="accent-primary"
            checked={used}
            aria-label={`Use ${name}`}
            onChange={(e) => onChange(e.target.checked ? "*" : undefined)}
          />
          <ConnectorIcon catalogId={connector.catalogId} name={connector.name} color={connector.icon?.color} iconUrl={connector.iconUrl} iconDarkUrl={connector.iconDarkUrl} size="sm" className="h-5 w-5 rounded-xs p-0.5" />
          <span className="min-w-0 truncate text-sm">{name}</span>
          <span className="shrink-0 font-mono text-caption text-muted-foreground">{connector.id}</span>
        </label>
        {used && (
          <SegmentedControl
            size="sm"
            aria-label={`Which ${name} tools`}
            value={wantsList ? "selected" : "all"}
            onValueChange={(v: "all" | "selected") => onChange(v === "all" ? "*" : (agentSelection === "*" ? (offered.length ? offered.map((t) => t.name) : []) : [...agentSelection]))}
          >
            <ToggleGroupItem value="all" aria-label="All its tools">All</ToggleGroupItem>
            <ToggleGroupItem value="selected" aria-label="Only selected">Only selected</ToggleGroupItem>
          </SegmentedControl>
        )}
      </div>
      {used && wantsList && (
        <div className="space-y-2 border-t border-border/40 px-2.5 py-2">
          {!tools && !error && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading tools…</p>}
          {error && <p className="text-xs text-destructive">{error}</p>}
          {tools && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${offered.length} tools`} aria-label={`Search ${name} tools`} className="h-7 pl-7 text-xs" />
                </div>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => onChange([...new Set([...picked, ...visible.map((t) => t.name)])])}>Select all</Button>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => onChange(picked.filter((n) => !visible.some((t) => t.name === n)))}>Select none</Button>
              </div>
              <ul className="max-h-60 divide-y overflow-y-auto rounded-md border border-border/40">
                {visible.map((tool) => (
                  <li key={tool.name}>
                    <label className="flex cursor-pointer items-start gap-2.5 px-2.5 py-1.5 hover:bg-muted/40">
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-primary"
                        checked={picked.includes(tool.name)}
                        aria-label={toolLabel(tool)}
                        onChange={(e) => onChange(e.target.checked ? [...new Set([...picked, tool.name])] : picked.filter((n) => n !== tool.name))}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{toolLabel(tool)}</span>
                        {toolLabel(tool) !== tool.name && <span className="block truncate font-mono text-caption text-muted-foreground">{tool.name}</span>}
                      </span>
                    </label>
                  </li>
                ))}
                {visible.length === 0 && <li className="px-2.5 py-2 text-xs text-muted-foreground">{offered.length ? `No tool matches “${query}”.` : "No tool to pick."}</li>}
              </ul>
              <p className="text-xs text-muted-foreground">{picked.length} of {offered.length} selected</p>
            </>
          )}
        </div>
      )}
    </li>
  );
}
