/**
 * Access: which agents may use this source, and how (Polpo's grants — Lumea has no equivalent).
 * A role per agent (no access, viewer = read, operator = read + write rows, steward = admin) and its
 * scope: every dataset or some, and fields it never sees.
 */
import { useState } from "react";
import { Loader2, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { useAgents } from "@polpo-ai/react";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { DataDataset, DataGrant, DataRegistry, DataSource } from "@/hooks/use-data";
import { datasetLabel, errorMessage, sourceInput } from "./data-utils";

type Role = "none" | "read" | "write" | "admin";
const ROLES: Array<{ value: Role; label: string; hint: string }> = [
  { value: "none", label: "No access", hint: "Cannot see the source" },
  { value: "read", label: "Viewer", hint: "Queries and SQL" },
  { value: "write", label: "Operator", hint: "Also inserts, updates, deletes rows" },
  { value: "admin", label: "Steward", hint: "Everything, including settings" },
];

function roleOf(grant?: DataGrant): Role {
  if (!grant) return "none";
  return grant.capabilities.includes("admin") ? "admin" : grant.capabilities.includes("write") ? "write" : "read";
}

export function AccessTab({ source, registry, datasets }: { source: DataSource; registry: DataRegistry; datasets: DataDataset[] }) {
  const { agents } = useAgents();
  const [saving, setSaving] = useState<string | null>(null);
  const [scoping, setScoping] = useState<DataGrant | null>(null);

  const save = async (agent: string, grants: DataGrant[], note: string) => {
    setSaving(agent);
    try { await registry.updateSource(source.id, sourceInput(source, { grants })); toast.success(note); }
    catch (error) { toast.error(errorMessage(error)); }
    finally { setSaving(null); }
  };
  const setRole = (agent: string, role: Role) => {
    const existing = source.grants.find((grant) => grant.agent === agent);
    const others = source.grants.filter((grant) => grant.agent !== agent);
    const grants = role === "none" ? others : [...others, { id: existing?.id ?? crypto.randomUUID(), agent, capabilities: [role], datasets: existing?.datasets ?? ["*"], excludedFields: existing?.excludedFields }];
    void save(agent, grants, role === "none" ? `${agent} no longer has access` : `${agent} is now ${ROLES.find((item) => item.value === role)?.label.toLowerCase()}`);
  };

  // agents that no longer exist keep their grant visible, so it can be removed
  const names = [...new Set([...agents.map((agent) => agent.name), ...source.grants.map((grant) => grant.agent)])];
  return (
    <div className="mx-auto w-full max-w-4xl">
      <div className="mb-4 flex items-start gap-3 rounded-card border border-border bg-muted/30 p-3">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="text-xs text-muted-foreground">
          An agent uses this source only with a grant here <em>and</em> the data tools assigned to it. The connection's credentials stay in the Vault: agents never see them.
          You (and Polpo) always have full access.
        </p>
      </div>
      {names.length === 0 ? <p className="py-8 text-center text-xs text-muted-foreground">No agents yet.</p> : (
        <ul className="divide-y divide-border rounded-card border border-border">
          {names.map((name) => {
            const agent = agents.find((item) => item.name === name);
            const grant = source.grants.find((item) => item.agent === name);
            const role = roleOf(grant);
            const scope = !grant ? "No access" : grant.datasets.length === 0 || grant.datasets.includes("*") ? "All datasets" : `${grant.datasets.length} dataset${grant.datasets.length === 1 ? "" : "s"}: ${grant.datasets.join(", ")}`;
            return (
              <li key={name} className="flex flex-wrap items-center gap-3 px-3 py-3 sm:flex-nowrap">
                <AgentAvatar avatar={agent?.identity?.avatar} name={name} color={agent?.identity?.color} size="md" fallbackVariant="circle" shape="circle" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{agent?.identity?.displayName ?? name}{!agent && <span className="ml-2 text-micro font-normal text-warning">agent not found</span>}</div>
                  <div className="truncate text-micro text-muted-foreground">{scope}{grant?.excludedFields?.length ? ` · ${grant.excludedFields.length} hidden field${grant.excludedFields.length === 1 ? "" : "s"}` : ""}</div>
                </div>
                {saving === name && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Saving" />}
                {grant && <Button variant="ghost" size="sm" onClick={() => setScoping(grant)} aria-label={`Scope for ${name}`}><SlidersHorizontal /> <span className="hidden sm:inline">Scope</span></Button>}
                <Select value={role} onValueChange={(value) => setRole(name, value as Role)} disabled={saving === name}>
                  <SelectTrigger size="sm" className="w-36 text-xs" aria-label={`Access for ${name}`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ROLES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        <span className="flex flex-col"><span>{item.label}</span><span className="text-micro text-muted-foreground">{item.hint}</span></span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </li>
            );
          })}
        </ul>
      )}
      <ScopeDialog
        grant={scoping}
        datasets={datasets}
        onClose={() => setScoping(null)}
        onSave={(next) => {
          setScoping(null);
          void save(next.agent, source.grants.map((grant) => (grant.agent === next.agent ? next : grant)), `Scope updated for ${next.agent}`);
        }}
      />
    </div>
  );
}

function ScopeDialog({ grant, datasets, onClose, onSave }: { grant: DataGrant | null; datasets: DataDataset[]; onClose: () => void; onSave: (grant: DataGrant) => void }) {
  return (
    <Dialog open={!!grant} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        {grant && <ScopeForm key={grant.id} grant={grant} datasets={datasets} onClose={onClose} onSave={onSave} />}
      </DialogContent>
    </Dialog>
  );
}

function ScopeForm({ grant, datasets, onClose, onSave }: { grant: DataGrant; datasets: DataDataset[]; onClose: () => void; onSave: (grant: DataGrant) => void }) {
  const [all, setAll] = useState(grant.datasets.length === 0 || grant.datasets.includes("*"));
  const [chosen, setChosen] = useState<Set<string>>(new Set(grant.datasets.filter((item) => item !== "*")));
  const [excluded, setExcluded] = useState((grant.excludedFields ?? []).join(", "));
  const toggle = (name: string) => setChosen((current) => { const next = new Set(current); if (next.has(name)) next.delete(name); else next.add(name); return next; });
  const submit = () => {
    const fields = excluded.split(",").map((item) => item.trim()).filter(Boolean);
    onSave({ ...grant, datasets: all || chosen.size === 0 ? ["*"] : [...chosen], excludedFields: fields.length ? fields : undefined });
  };
  return (
    <>
      <DialogHeader className="shrink-0 border-b px-6 pb-4 pt-6 pr-12">
        <DialogTitle>Scope for {grant.agent}</DialogTitle>
        <DialogDescription>Which datasets it may use, and fields it never sees (left out of its schema and refused in its queries).</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={all} onCheckedChange={(value) => setAll(value === true)} /> Every dataset (also ones created later)</label>
          {!all && (
            <ul className="max-h-60 overflow-auto rounded-card border border-border p-1.5">
              {datasets.map((dataset) => (
                <li key={dataset.id}>
                  <label className="flex items-center gap-2 rounded-xs px-2 py-1 text-xs hover:bg-muted">
                    <Checkbox checked={chosen.has(dataset.name)} onCheckedChange={() => toggle(dataset.name)} />
                    <span className="font-mono">{datasetLabel(dataset)}</span>
                  </label>
                </li>
              ))}
              {/* patterns or names the schema no longer lists */}
              {[...chosen].filter((name) => !datasets.some((dataset) => dataset.name === name)).map((name) => (
                <li key={name}><label className="flex items-center gap-2 rounded-xs px-2 py-1 text-xs hover:bg-muted"><Checkbox checked onCheckedChange={() => toggle(name)} /><span className="font-mono">{name}</span></label></li>
              ))}
            </ul>
          )}
          <label className="grid gap-1.5 text-xs font-medium">
            Hidden fields
            <Input value={excluded} onChange={(event) => setExcluded(event.target.value)} placeholder="email, phone, salary" className="font-mono" />
            <span className="font-normal text-muted-foreground">Comma separated column names, in any dataset.</span>
          </label>
        </div>
        <DialogFooter sticky>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit}>Save scope</Button>
        </DialogFooter>
      </DialogBody>
    </>
  );
}
