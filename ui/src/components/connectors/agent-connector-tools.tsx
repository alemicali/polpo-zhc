/**
 * Agent page → Connectors → one granted connector, expanded: which of its tools this agent gets.
 * "All tools" (the default: every current and future tool) or "Only selected" (checkboxes over the
 * connector's cached tool list, with a search filter and select all / none). Saved on the agent as
 * `connectorTools[<connector id>]` (PATCH /agents/:name). Selected names the connector no longer
 * lists are kept and shown as stale; tools turned Off on the connector stay off for everyone.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  connectorState, connectorToolsEntry, connectorsApi, filterConnectorTools, saveAgentConnectorTools, staleConnectorTools, toolLabel,
  withConnectorToolsEntry,
  type AgentConnectorTools, type Connector, type ConnectorTool,
} from "@/lib/connectors-api";
import { cn } from "@/lib/utils";

type Mode = "all" | "selected";

const sameSelection = (a: "*" | string[], b: "*" | string[]) =>
  a === "*" || b === "*" ? a === b : a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

export function AgentConnectorTools({
  agentName, connector, selection, onSaved,
}: {
  agentName: string;
  connector: Connector;
  /** The agent's whole connectorTools (every connector), as saved. */
  selection: AgentConnectorTools | undefined;
  onSaved: (next: AgentConnectorTools | undefined) => void | Promise<void>;
}) {
  const saved = connectorToolsEntry(selection, connector.id);
  const [mode, setMode] = useState<Mode>(saved === "*" ? "all" : "selected");
  const [picked, setPicked] = useState<string[]>(saved === "*" ? [] : saved);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [tools, setTools] = useState<ConnectorTool[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = connectorState(connector);
  const canList = state === "connected" || state === "not_connected" || state === "error";
  const [loading, setLoading] = useState(canList);

  useEffect(() => {
    if (!canList) return;
    let cancelled = false;
    connectorsApi.tools(connector.id).then(
      (list) => { if (!cancelled) { setTools(list); setError(null); setLoading(false); } },
      (reason: unknown) => { if (!cancelled) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); } },
    );
    return () => { cancelled = true; };
  }, [connector.id, canList]);

  const draft: "*" | string[] = mode === "all" ? "*" : picked;
  const dirty = !sameSelection(draft, saved);
  const stale = staleConnectorTools(draft, tools);
  const visible = useMemo(() => filterConnectorTools(tools ?? [], query), [tools, query]);
  const policyOf = (tool: ConnectorTool) => connector.toolPolicy?.[tool.name] ?? tool.policy ?? "allow";
  const selectable = visible.filter((t) => policyOf(t) !== "off").map((t) => t.name);

  const toggle = (name: string, on: boolean) => setPicked((cur) => (on ? [...new Set([...cur, name])] : cur.filter((n) => n !== name)));
  const selectAll = () => setPicked((cur) => [...new Set([...cur, ...selectable])]);
  const selectNone = () => setPicked((cur) => cur.filter((n) => !selectable.includes(n)));

  const save = async () => {
    setSaving(true);
    try {
      const next = withConnectorToolsEntry(selection, connector.id, draft);
      const updated = await saveAgentConnectorTools(agentName, next);
      await onSaved(updated?.connectorTools ?? next ?? undefined);
      toast.success(draft === "*" ? `${agentName} gets every ${connector.name} tool` : `${agentName} gets ${draft.length} ${connector.name} tool${draft.length === 1 ? "" : "s"}`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setMode(saved === "*" ? "all" : "selected");
    setPicked(saved === "*" ? [] : saved);
  };

  return (
    <div data-testid={`agent-connector-tools-${connector.id}`} className="space-y-2 border-t border-border/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl size="sm" aria-label={`Which ${connector.name} tools ${agentName} gets`} value={mode} onValueChange={(next: Mode) => {
          setMode(next);
          // switching to "Only selected" the first time starts from every tool it has today
          if (next === "selected" && saved === "*" && picked.length === 0 && tools) setPicked(tools.filter((t) => policyOf(t) !== "off").map((t) => t.name));
        }}>
          <ToggleGroupItem value="all" aria-label="All tools">All tools</ToggleGroupItem>
          <ToggleGroupItem value="selected" aria-label="Only selected">Only selected</ToggleGroupItem>
        </SegmentedControl>
        {mode === "selected" && tools && (
          <span className="text-xs text-muted-foreground">{picked.filter((n) => !stale.includes(n)).length} of {tools.length} selected</span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {dirty && <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={saving} onClick={reset}>Cancel</Button>}
          <Button size="sm" className="h-7 text-xs" disabled={!dirty || saving} onClick={() => void save()}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
          </Button>
        </div>
      </div>

      {mode === "all" ? (
        <p className="text-xs text-muted-foreground">
          Every tool of {connector.name}{connector.toolCount !== undefined ? ` (${connector.toolCount} today)` : ""}, and the ones it adds later.
        </p>
      ) : (
        <>
          {!canList && <p className="text-xs text-muted-foreground">Connect {connector.name} to see its tools; the saved selection is kept.</p>}
          {canList && loading && !tools && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading tools…</p>}
          {error && <p className="text-xs text-destructive">{error}</p>}
          {tools && tools.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`Search ${tools.length} tools`}
                    aria-label={`Search ${connector.name} tools`}
                    className="h-7 pl-7 text-xs"
                  />
                </div>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={selectAll} disabled={selectable.length === 0}>Select all</Button>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={selectNone} disabled={selectable.length === 0}>Select none</Button>
              </div>
              <ul className="max-h-72 divide-y overflow-y-auto rounded-md border border-border/40">
                {visible.map((tool) => {
                  const off = policyOf(tool) === "off";
                  const checked = !off && picked.includes(tool.name);
                  return (
                    <li key={tool.name}>
                      <label className={cn("flex cursor-pointer items-start gap-2.5 px-2.5 py-1.5 hover:bg-muted/40", off && "cursor-not-allowed opacity-60")}>
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-primary"
                          checked={checked}
                          disabled={off}
                          aria-label={toolLabel(tool)}
                          onChange={(e) => toggle(tool.name, e.target.checked)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className={cn("truncate text-sm", off && "line-through")}>{toolLabel(tool)}</span>
                            {off && <Badge variant="outline" className="text-micro px-1 py-0">Off for everyone</Badge>}
                          </span>
                          {toolLabel(tool) !== tool.name && <span className="block truncate font-mono text-caption text-muted-foreground">{tool.name}</span>}
                          {tool.description && <span className="line-clamp-2 block text-xs text-muted-foreground">{tool.description}</span>}
                        </span>
                      </label>
                    </li>
                  );
                })}
                {visible.length === 0 && <li className="px-2.5 py-2 text-xs text-muted-foreground">No tool matches “{query}”.</li>}
              </ul>
            </>
          )}
          {tools && tools.length === 0 && <p className="text-xs text-muted-foreground">This server lists no tools.</p>}
          {!tools && picked.length > 0 && (
            <div className="flex flex-wrap gap-1" data-testid="saved-connector-tools">
              {picked.map((name) => <Badge key={name} variant="outline" className="font-mono text-micro">{name}</Badge>)}
            </div>
          )}
          {stale.length > 0 && (
            <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5" data-testid="stale-connector-tools">
              <p className="flex items-center gap-1 text-xs text-warning">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                Selected, but {connector.name} does not list {stale.length === 1 ? "this tool" : "these tools"} now (renamed, removed, or the connector is not connected):
              </p>
              <div className="flex flex-wrap gap-1">
                {stale.map((name) => (
                  <Badge key={name} variant="outline" className="gap-1 font-mono text-micro">
                    {name}
                    <button type="button" aria-label={`Remove ${name}`} className="text-muted-foreground hover:text-foreground" onClick={() => toggle(name, false)}>
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {picked.length === 0 && <p className="text-xs text-muted-foreground">No tool selected: {agentName} gets none of {connector.name}'s tools.</p>}
        </>
      )}
    </div>
  );
}
