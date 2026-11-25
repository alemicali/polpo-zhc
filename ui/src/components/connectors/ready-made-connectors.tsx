/**
 * Ready-made connectors, hosted by Polpo: the curated templates (Printful, Gelato, Printify…) as a
 * catalog — vendor, category, what is safe to call (read-only) and what needs approval, maturity,
 * and where each stands here (available, installed vX, update available) — and the install dialog:
 * settings → secrets (straight to the vault, never shown again) → which agents may use it → the
 * template's read-only tests → publish v1.0.0 + deploy. An update makes the new revision a draft
 * with its changes, to publish from the server's Versions tab.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ArrowUpCircle, CheckCircle2, Download, ExternalLink, FlaskConical, Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { useMcpServers, type McpServerInstallResult, type McpServerTemplateInfo } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConnectorIcon } from "./connector-icon";
import type { AgentOption } from "./connector-detail-sheet";
import { SecretHelp, SecretInput, SettingInput, settingsPayload, type SettingValue } from "./template-fields";
import { productName, useInstanceBranding } from "@/lib/branding";

const iconSlug = (icon?: string) => (icon && /^[a-z0-9]+$/.test(icon) ? icon : undefined);

/** The status line of a template card. */
export function templateStatusLabel(t: McpServerTemplateInfo): string {
  const i = t.installs.find((x) => x.status === t.status) ?? t.installs[0];
  switch (t.status) {
    case "installed": return `Installed · v${i?.production}`;
    case "update_available": return `Installed · v${i?.production} · update available (revision ${t.revision})`;
    case "draft": return "Install not finished";
    default: return "Available";
  }
}

function TemplateCard({ t, onInstall, onOpen }: { t: McpServerTemplateInfo; onInstall: () => void; onOpen: (id: string) => void }) {
  const install = t.installs[0];
  return (
    <div className="flex flex-col gap-3 rounded-card border bg-card p-4" data-testid={`ready-made-${t.id}`}>
      <div className="flex items-start gap-3">
        {t.icon && !iconSlug(t.icon) ? <span className="text-2xl" aria-hidden>{t.icon}</span> : <ConnectorIcon catalogId={iconSlug(t.icon)} name={t.name} />}
        <div className="min-w-0 flex-1">
          <p className="font-medium">{t.name}</p>
          <p className="text-xs text-muted-foreground">{t.vendor} · {t.category}</p>
        </div>
        <Badge variant={t.status === "available" ? "outline" : t.status === "update_available" ? "default" : "secondary"} className="text-micro font-normal">
          {templateStatusLabel(t)}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">{t.description}</p>
      <div className="space-y-1 text-xs text-muted-foreground">
        <p className="flex items-start gap-1.5"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> <span><span className="font-medium text-foreground">{t.readOnlyTools.length} read-only</span>: {t.readOnlyTools.join(", ")}</span></p>
        {t.approvalTools.length > 0 && (
          <p className="flex items-start gap-1.5"><ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" /> <span><span className="font-medium text-foreground">Needs approval</span>: {t.approvalTools.join(", ")}</span></p>
        )}
        <p className="flex items-start gap-1.5">
          <FlaskConical className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t.maturity.testedWithLiveApi ? "Tested with the live API" : "Not yet tested with the live API"} · revision {t.revision}
        </p>
      </div>
      <div className="mt-auto flex flex-wrap gap-2">
        {t.status === "available" || t.status === "draft" ? (
          <Button size="sm" onClick={onInstall}><Download className="h-3.5 w-3.5" /> {t.status === "draft" ? "Finish install" : "Install"}</Button>
        ) : t.status === "update_available" ? (
          <Button size="sm" onClick={onInstall}><ArrowUpCircle className="h-3.5 w-3.5" /> Update</Button>
        ) : null}
        {install && <Button size="sm" variant="outline" onClick={() => onOpen(install.serverId)}>Open</Button>}
        <Button size="sm" variant="ghost" asChild><a href={t.docs} target="_blank" rel="noreferrer">API docs <ExternalLink className="h-3 w-3" /></a></Button>
      </div>
    </div>
  );
}

/** The catalog section (Connectors → Hosted servers). */
export function ReadyMadeConnectors({ agents, onOpenServer }: { agents: AgentOption[]; onOpenServer: (id: string) => void }) {
  const { templates, isLoading } = useMcpServers();
  const product = productName(useInstanceBranding());
  const [installing, setInstalling] = useState<string | null>(null);
  const current = templates.find((t) => t.id === installing) ?? null;
  if (isLoading || templates.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="ready-made-title">
      <div>
        <h2 id="ready-made-title" className="text-sm font-medium">Ready-made (hosted by {product})</h2>
        <p className="text-sm text-muted-foreground">Curated connectors {product} hosts for you: fill in the settings, paste the vendor's token, choose the agents — tested and published in one step.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {templates.map((t) => <TemplateCard key={t.id} t={t} onInstall={() => setInstalling(t.id)} onOpen={onOpenServer} />)}
      </div>
      {current && (
        <InstallTemplateDialog
          template={current} agents={agents} open={!!current}
          onOpenChange={(o) => { if (!o) setInstalling(null); }}
          onOpenServer={(id) => { setInstalling(null); onOpenServer(id); }}
        />
      )}
    </section>
  );
}

/** What the install answered, for the dialog. */
export function installOutcome(r: McpServerInstallResult): { tone: "ok" | "warn"; title: string; lines: string[] } {
  switch (r.status) {
    case "installed": return { tone: "ok", title: `Installed: ${r.id} v${r.version}`, lines: [`Read-only tests: ${r.tests?.passed ?? 0} passed${r.tests?.skipped ? `, ${r.tests.skipped} skipped` : ""}.`] };
    case "needs_secrets": return { tone: "warn", title: "A secret is missing", lines: [`Paste ${r.missingSecrets?.join(", ")} and install again: nothing was published.`] };
    case "tests_failed": return {
      tone: "warn", title: "A read-only test failed — nothing was published",
      lines: (r.tests?.results ?? []).filter((x) => x.passed === false).map((x) => `${x.tool}: ${x.error ?? x.text}`),
    };
    case "upgrade_draft": return {
      tone: "ok", title: `Revision ${r.revision} is now the draft of ${r.id}`,
      lines: [(r.diff?.changes ?? []).map((c) => `${c.kind} ${c.field}`).join(", ") || "No changes to the tools", "Review it and publish it from the Versions tab."],
    };
    case "up_to_date": return { tone: "ok", title: `${r.id} is up to date (v${r.version})`, lines: ["Settings and access saved."] };
    default: return { tone: "ok", title: "Checks passed", lines: ["Kept as a draft."] };
  }
}

export function InstallTemplateDialog({ template: t, agents, open, onOpenChange, onOpenServer }: {
  template: McpServerTemplateInfo; agents: AgentOption[]; open: boolean;
  onOpenChange: (open: boolean) => void; onOpenServer: (id: string) => void;
}) {
  const { install } = useMcpServers();
  const product = productName(useInstanceBranding());
  const [settings, setSettings] = useState<Record<string, SettingValue>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [allAgents, setAllAgents] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<McpServerInstallResult | null>(null);
  const updating = t.status === "update_available" || t.status === "installed";
  const outcome = useMemo(() => (result ? installOutcome(result) : null), [result]);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const values = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim()));
      const r = await install(t.id, {
        settings: settingsPayload(settings),
        ...(Object.keys(values).length ? { secrets: values } : {}),
        agents: allAgents ? "*" : chosen,
      });
      setSecrets({}); // sent to the vault: not kept here
      setResult(r);
      if (r.status === "installed") toast.success(`${t.name} installed (v${r.version})`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="install-template-dialog">
        <DialogHeader>
          <DialogTitle>{updating ? `Update ${t.name}` : `Install ${t.name}`}</DialogTitle>
          <DialogDescription>
            {updating
              ? `Revision ${t.revision} becomes a draft with its changes; you publish it when it looks right.`
              : `${product} checks it with the read-only tests, then publishes v1.0.0 and adds it to your connectors.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {!t.maturity.testedWithLiveApi && (
            <p className="flex gap-2 text-xs text-warning" role="note">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Not yet tested with the live API{t.maturity.note ? `: ${t.maturity.note}` : "."}
            </p>
          )}

          {t.settings.length > 0 && (
            <section className="space-y-3">
              <h3 className="text-sm font-medium">1 · Settings</h3>
              {t.settings.map((f) => (
                <SettingInput key={f.key} field={f} value={settings[f.key]} disabled={busy} onChange={(v) => setSettings((s) => ({ ...s, [f.key]: v }))} />
              ))}
            </section>
          )}

          <section className="space-y-3 border-t pt-4">
            <h3 className="text-sm font-medium">{t.settings.length ? "2" : "1"} · Credentials <span className="font-normal text-muted-foreground">(saved in the vault; never shown again)</span></h3>
            {t.secrets.map((s) => (
              <div key={s.name} className="space-y-1.5">
                <SecretInput name={s.name} label={s.label} disabled={busy} value={secrets[s.name] ?? ""} onChange={(v) => setSecrets((x) => ({ ...x, [s.name]: v }))} />
                <SecretHelp info={s} />
                <p className="text-micro text-muted-foreground">Vault entry {s.vault.owner} / {s.vault.service}, field {s.vault.key}{updating ? " — leave it empty to keep the saved one" : ""}.</p>
              </div>
            ))}
          </section>

          <section className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-medium">{t.settings.length ? "3" : "2"} · Who can use it</h3>
            <p className="text-xs text-muted-foreground">{product} can always use it. Agents see its tools only when they are chosen here (or later in the connector).</p>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={allAgents} disabled={busy} onCheckedChange={(v) => setAllAgents(v === true)} aria-label="All agents" /> All agents
            </label>
            {!allAgents && agents.length > 0 && (
              <div className="grid gap-1 sm:grid-cols-2">
                {agents.map((a) => (
                  <label key={a.name} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={chosen.includes(a.name)} disabled={busy} aria-label={a.label}
                      onCheckedChange={(v) => setChosen((c) => (v === true ? [...c, a.name] : c.filter((x) => x !== a.name)))} />
                    <span className="truncate">{a.label}</span>
                  </label>
                ))}
              </div>
            )}
            {!allAgents && chosen.length === 0 && <p className="text-xs text-warning" data-testid="no-agents-note">No agent chosen: only {product} will see its tools.</p>}
          </section>

          {outcome && (
            <div className={outcome.tone === "ok" ? "space-y-1 border-t pt-4 text-sm" : "space-y-1 border-t pt-4 text-sm text-warning"} role="status" data-testid="install-outcome">
              <p className="flex items-center gap-1.5 font-medium">
                {outcome.tone === "ok" ? <CheckCircle2 className="h-4 w-4 text-success" /> : <AlertTriangle className="h-4 w-4" />} {outcome.title}
              </p>
              {outcome.lines.map((l) => <p key={l} className="text-xs">{l}</p>)}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {result && ["installed", "upgrade_draft", "up_to_date"].includes(result.status) ? (
            <Button onClick={() => onOpenServer(result.id)}>Open {result.status === "upgrade_draft" ? "the draft" : "the server"}</Button>
          ) : (
            <Button disabled={busy} onClick={() => void run()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : updating ? <ArrowUpCircle className="h-4 w-4" /> : <Download className="h-4 w-4" />}
              {busy ? "Testing and publishing…" : updating ? "Make the update a draft" : "Install"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
