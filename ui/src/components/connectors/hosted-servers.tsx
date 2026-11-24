/**
 * Hosted MCP servers: the servers Polpo builds and serves itself, each a connector once published.
 * The list (Connectors → Hosted servers) and the "Create server" dialog: from a template (Printful),
 * from an API (OpenAPI URL / pasted docs → a curated set of tools by Polpo's model), from a
 * description (code tools), or blank. Everything starts as a draft.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Boxes, FileCode2, Globe, LayoutTemplate, Loader2, Lock, PenLine, Server, Sparkles } from "lucide-react";
import { useMcpServers, type McpServerGenerateResult, type McpServerSummary } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SegmentedControl, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ConnectorIcon } from "./connector-icon";
import { blankSpec } from "@/lib/mcp-servers";
import { productName, useInstanceBranding } from "@/lib/branding";

function ServerRow({ server, onOpen }: { server: McpServerSummary; onOpen: () => void }) {
  return (
    <button
      type="button" onClick={onOpen} data-testid={`hosted-server-${server.id}`}
      className="flex w-full items-center gap-3 rounded-card border bg-card px-3 py-3 text-left transition-colors hover:border-foreground/20 sm:px-4"
    >
      <ConnectorIcon catalogId={server.icon && /^[a-z0-9]+$/.test(server.icon) ? server.icon : undefined} name={server.name} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{server.name}</span>
          {server.visibility === "public"
            ? <Badge variant="outline" className="gap-1 text-micro font-normal"><Globe className="h-3 w-3" /> Public</Badge>
            : <Badge variant="secondary" className="gap-1 text-micro font-normal"><Lock className="h-3 w-3" /> Private</Badge>}
          {server.disabled && <Badge variant="destructive" className="text-micro font-normal">Switched off</Badge>}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {server.production ? `v${server.production} in production` : "Draft, not published"}
          {server.draftChanged && server.production ? " · draft has changes" : ""}
          {` · ${server.toolCount} tools`}
          {server.pendingApprovals ? ` · ${server.pendingApprovals} waiting for approval` : ""}
        </span>
      </span>
    </button>
  );
}

export function HostedServersList({ onOpen, onCreate }: { onOpen: (id: string) => void; onCreate: () => void }) {
  const { servers, isLoading, error, refetch } = useMcpServers();
  const product = productName(useInstanceBranding());
  if (isLoading) return <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading servers…</p>;
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
        {error.message}
        <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => void refetch()}>Retry</Button>
      </div>
    );
  }
  if (servers.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-12 text-center">
        <Server className="h-8 w-8 text-muted-foreground" />
        <div>
          <p className="font-medium">No hosted servers yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            {product} can build an MCP server for any API — from its docs, a description or a template — host it, and add it as a connector.
          </p>
        </div>
        <Button onClick={onCreate}><Sparkles className="h-4 w-4" /> Create server</Button>
      </div>
    );
  }
  return <div className="space-y-2">{servers.map((s) => <ServerRow key={s.id} server={s} onOpen={() => onOpen(s.id)} />)}</div>;
}

type Mode = "template" | "api" | "description" | "blank";

export function CreateServerDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (id: string) => void }) {
  const { templates, create, generate } = useMcpServers();
  const [mode, setMode] = useState<Mode>("template");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [goal, setGoal] = useState("");
  const [name, setName] = useState("");
  const [proposal, setProposal] = useState<McpServerGenerateResult | null>(null);

  const reset = () => { setProposal(null); setUrl(""); setText(""); setGoal(""); setName(""); };
  const done = (id: string, setup?: string) => {
    if (setup) toast.info(setup, { duration: 10_000 });
    onOpenChange(false);
    reset();
    onCreated(id);
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (reason) { toast.error(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create an MCP server</DialogTitle>
          <DialogDescription>It starts as a draft: review the tools, test them, then publish. Publishing adds it to your connectors.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <SegmentedControl value={mode} onValueChange={(v) => { setMode(v as Mode); setProposal(null); }} aria-label="How to create it">
            <ToggleGroupItem value="template" aria-label="From a template"><LayoutTemplate className="h-3.5 w-3.5" /> Template</ToggleGroupItem>
            <ToggleGroupItem value="api" aria-label="From an API"><Boxes className="h-3.5 w-3.5" /> From API</ToggleGroupItem>
            <ToggleGroupItem value="description" aria-label="From a description"><FileCode2 className="h-3.5 w-3.5" /> From description</ToggleGroupItem>
            <ToggleGroupItem value="blank" aria-label="Blank"><PenLine className="h-3.5 w-3.5" /> Blank</ToggleGroupItem>
          </SegmentedControl>

          {mode === "template" && (
            <div className="space-y-2">
              {templates.map((t) => (
                <div key={t.id} className="flex items-start gap-3 rounded-card border p-3" data-testid={`template-${t.id}`}>
                  <ConnectorIcon catalogId={t.id} name={t.name} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="font-medium">{t.name}</p>
                    <p className="text-sm text-muted-foreground">{t.description}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.tools.map((x) => x.name).join(", ")} · {t.tools.filter((x) => x.requiresApproval).length} need approval
                    </p>
                    <p className="text-xs text-muted-foreground">{t.setup}</p>
                  </div>
                  <Button size="sm" disabled={busy} onClick={() => void run(async () => { const r = await create({ template: t.id }); done(r.id, t.setup); })}>
                    Use
                  </Button>
                </div>
              ))}
            </div>
          )}

          {(mode === "api" || mode === "description") && !proposal && (
            <div className="space-y-3">
              {mode === "api" && (
                <label className="block space-y-1 text-sm">
                  <span className="font-medium">OpenAPI URL</span>
                  <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/openapi.json" aria-label="OpenAPI URL" />
                </label>
              )}
              <label className="block space-y-1 text-sm">
                <span className="font-medium">{mode === "api" ? "…or paste the OpenAPI document or the API docs" : "What should the tools do?"}</span>
                <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={7} className="font-mono text-xs" aria-label={mode === "api" ? "API document" : "Description"}
                  placeholder={mode === "api" ? "openapi: 3.0.0 …" : "e.g. convert a price between currencies using the ECB rates; slugify a title"} />
              </label>
              <label className="block space-y-1 text-sm">
                <span className="font-medium">What is it for? <span className="font-normal text-muted-foreground">(optional: steers which tools are kept)</span></span>
                <Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. quote and create print-on-demand orders" aria-label="Goal" />
              </label>
            </div>
          )}

          {proposal && (
            <div className="space-y-2" data-testid="server-proposal">
              <p className="text-sm"><span className="font-medium">{proposal.spec.name}</span> · {proposal.spec.tools.length} tools{proposal.source.endpoints ? ` (from ${proposal.source.endpoints} operations)` : ""}</p>
              <ul className="space-y-1 text-sm">
                {proposal.spec.tools.map((t) => (
                  <li key={t.name} className="flex gap-2">
                    <code className="shrink-0 text-xs">{t.name}</code>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{t.description}</span>
                    {t.requiresApproval && <Badge variant="outline" className="text-micro font-normal">approval</Badge>}
                  </li>
                ))}
              </ul>
              {[...proposal.notes, ...proposal.problems].map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}
            </div>
          )}

          {mode === "blank" && (
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My API" aria-label="Server name" />
            </label>
          )}
        </DialogBody>
        <DialogFooter>
          {(mode === "api" || mode === "description") && !proposal && (
            <Button disabled={busy || (!url.trim() && !text.trim())} onClick={() => void run(async () => {
              setProposal(await generate({ mode, ...(url.trim() ? { url: url.trim() } : {}), ...(text.trim() ? { text } : {}), ...(goal.trim() ? { goal } : {}) }));
            })}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Propose tools
            </Button>
          )}
          {proposal && (
            <>
              <Button variant="outline" disabled={busy} onClick={() => setProposal(null)}>Back</Button>
              <Button disabled={busy} onClick={() => void run(async () => { const r = await create({ spec: proposal.spec }); done(r.id); })}>Create draft</Button>
            </>
          )}
          {mode === "blank" && (
            <Button disabled={busy || !name.trim()} onClick={() => void run(async () => { const r = await create({ spec: blankSpec(name.trim()) }); done(r.id); })}>Create draft</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
