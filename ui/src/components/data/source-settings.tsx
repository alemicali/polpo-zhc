/**
 * A source's settings: connection (connector, location, port, database, user, TLS), description,
 * environment and categories; credentials, which go to the Vault and are never shown again (only
 * which ones are stored); the connection test; deleting the source. The same form connects a new
 * source in a dialog. An assistant's setup link (?setup=data:<id>:password) lands on the secret field.
 */
import { useEffect, useState } from "react";
import { Check, KeyRound, Loader2, PlugZap, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { DataRegistry, DataSource, DataSourceDetail, DataSourceInput, DataSourceKind } from "@/hooks/use-data";
import { focusSetupField, notifySetupSaved, readSetupParams } from "@/lib/setup-link";
import { cn } from "@/lib/utils";
import { SourceIcon } from "./source-icon";
import { errorMessage, SOURCE_KINDS, slugify, useLoader } from "./data-utils";

type FormState = {
  kind: DataSourceKind; name: string; description: string; location: string; port: string; database: string;
  username: string; ssl: boolean; secret: string; defaultDataset: string; environment: DataSource["environment"]; tags: string;
};

function initialForm(source?: DataSource): FormState {
  return {
    kind: source?.kind ?? "postgres", name: source?.name ?? "", description: source?.description ?? "",
    location: source?.config.location ?? "", port: String(source?.config.port ?? 5432), database: source?.config.database ?? "",
    username: source?.config.username ?? "", ssl: !!source?.config.ssl, secret: "", defaultDataset: source?.config.defaultDataset ?? "",
    environment: source?.environment ?? "development", tags: source?.tags.join(", ") ?? "",
  };
}

function toInput(form: FormState, source?: DataSource): DataSourceInput {
  const { kind } = form;
  return {
    name: form.name.trim(), slug: source?.slug ?? slugify(form.name), description: form.description.trim() || undefined, kind, environment: form.environment,
    config: {
      location: form.location.trim(),
      ...(kind === "postgres" ? { port: Number(form.port) || 5432, database: form.database.trim() || undefined, username: form.username.trim() || undefined, ssl: form.ssl || undefined } : {}),
      ...(kind === "rest" || kind === "json" || kind === "csv" ? { defaultDataset: form.defaultDataset.trim() || undefined } : {}),
    },
    tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    grants: source?.grants ?? [],
    ...(form.secret ? { credentials: kind === "rest" ? { authorization: form.secret } : { password: form.secret } } : {}),
  };
}

/** The secret a connector takes (stored in the Vault). */
function secretField(kind: DataSourceKind): { key: string; label: string } | null {
  if (kind === "postgres") return { key: "password", label: "Password" };
  if (kind === "rest") return { key: "authorization", label: "Authorization header" };
  return null;
}

function SourceFields({ form, set, editing, storedKeys }: { form: FormState; set: (patch: Partial<FormState>) => void; editing: boolean; storedKeys: string[] }) {
  const secret = secretField(form.kind);
  const stored = secret ? storedKeys.includes(secret.key) : false;
  return (
    <div className="grid gap-4">
      {!editing && (
        <fieldset>
          <legend className="text-xs font-medium">Connector</legend>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5" role="radiogroup" aria-label="Connector">
            {SOURCE_KINDS.map((item) => (
              <button key={item.kind} type="button" role="radio" aria-checked={form.kind === item.kind} onClick={() => set({ kind: item.kind })}
                className={cn("rounded-control border p-2 text-left transition-colors", form.kind === item.kind ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50")}>
                <SourceIcon kind={item.kind} />
                <span className="mt-2 block text-caption font-medium">{item.label}</span>
                <span className="block text-micro text-muted-foreground">{item.description}</span>
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input value={form.name} onChange={(event) => set({ name: event.target.value })} required /></Field>
        <Field label="Environment">
          <Select value={form.environment} onValueChange={(value) => set({ environment: value as DataSource["environment"] })}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="development">Development</SelectItem><SelectItem value="staging">Staging</SelectItem><SelectItem value="production">Production</SelectItem></SelectContent>
          </Select>
        </Field>
      </div>
      <Field label="Description"><Input value={form.description} onChange={(event) => set({ description: event.target.value })} placeholder="What this source contains" /></Field>
      <Field label={form.kind === "postgres" ? "Host" : form.kind === "rest" ? "Base URL" : "File path"} hint={form.kind === "sqlite" || form.kind === "json" || form.kind === "csv" ? "Absolute, or relative to the agents' working directory" : undefined}>
        <Input value={form.location} onChange={(event) => set({ location: event.target.value })} className="font-mono" required
          placeholder={form.kind === "postgres" ? "db.example.com" : form.kind === "rest" ? "https://api.example.com/v1/" : "data/business.sqlite"} />
      </Field>
      {form.kind === "postgres" && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Port"><Input value={form.port} onChange={(event) => set({ port: event.target.value })} inputMode="numeric" /></Field>
            <Field label="Database"><Input value={form.database} onChange={(event) => set({ database: event.target.value })} /></Field>
            <Field label="User"><Input value={form.username} onChange={(event) => set({ username: event.target.value })} autoComplete="off" /></Field>
          </div>
          <label className="flex items-center gap-2 text-xs"><Switch checked={form.ssl} onCheckedChange={(value) => set({ ssl: value })} /> Require TLS (SSL)</label>
        </>
      )}
      {(form.kind === "rest" || form.kind === "json" || form.kind === "csv") && (
        <Field label={form.kind === "rest" ? "Default endpoint" : "Dataset name"}>
          <Input value={form.defaultDataset} onChange={(event) => set({ defaultDataset: event.target.value })} className="font-mono" placeholder={form.kind === "rest" ? "/customers" : "records"} />
        </Field>
      )}
      {secret && (
        <div className="rounded-card border border-border bg-muted/30 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium">
            <KeyRound className="size-3.5 text-primary" /> {secret.label}
            <span className={cn("ml-auto rounded-badge px-1.5 text-micro", stored ? "bg-success/15 text-success" : "bg-warning/15 text-warning")}>{stored ? "stored in Vault" : "not set"}</span>
          </div>
          <Input
            data-setup-field={secret.key}
            type="password"
            autoComplete="new-password"
            value={form.secret}
            onChange={(event) => set({ secret: event.target.value })}
            aria-label={secret.label}
            placeholder={stored ? "Leave empty to keep the stored one" : form.kind === "rest" ? "Bearer …" : "Stored encrypted in the Vault"}
          />
          <p className="mt-1.5 text-micro text-muted-foreground">Encrypted in the Vault; never shown again, never sent to agents.</p>
        </div>
      )}
      <Field label="Categories" hint="Comma separated"><Input value={form.tags} onChange={(event) => set({ tags: event.target.value })} placeholder="internal, finance" /></Field>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="grid gap-1.5"><span className="text-xs font-medium">{label}</span>{children}{hint && <span className="text-micro text-muted-foreground">{hint}</span>}</label>;
}

/** Saves, then tests the connection and says how it went. */
async function saveSource(registry: DataRegistry, input: DataSourceInput, source?: DataSource): Promise<DataSource> {
  const saved = source ? await registry.updateSource(source.id, input) : await registry.createSource(input);
  toast.success(source ? "Settings saved" : "Data source connected");
  if (input.credentials) notifySetupSaved();
  void registry.testSource(saved.id)
    .then((result) => toast.success(`Connection verified in ${result.latencyMs} ms · ${result.datasets} datasets`))
    .catch((error) => toast.warning(`Saved, but the connection test failed: ${errorMessage(error)}`));
  return saved;
}

export function SettingsTab({ source, registry, onDeleted }: { source: DataSource; registry: DataRegistry; onDeleted: () => void }) {
  const detail = useLoader<DataSourceDetail>(`detail:${source.id}:${source.updatedAt}`, () => registry.getSource(source.id));
  const [form, setForm] = useState(() => initialForm(source));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => focusSetupField(readSetupParams()), []);

  const save = async () => {
    if (!form.name.trim() || !form.location.trim()) return;
    setSaving(true);
    try { await saveSource(registry, toInput(form, source), source); setForm((current) => ({ ...current, secret: "" })); detail.reload(); }
    catch (error) { toast.error(errorMessage(error)); }
    finally { setSaving(false); }
  };
  const test = async () => {
    setTesting(true);
    try { const result = await registry.testSource(source.id); toast.success(`Connected in ${result.latencyMs} ms · ${result.datasets} datasets`); }
    catch (error) { toast.error(errorMessage(error)); }
    finally { setTesting(false); }
  };
  const remove = async () => {
    setDeleting(true);
    try { await registry.deleteSource(source.id); toast.success(`${source.name} removed`); onDeleted(); }
    catch (error) { toast.error(errorMessage(error)); setDeleting(false); }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 pb-8">
      <section>
        <header className="mb-4 flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-h3 font-semibold">Connection</h2>
          <Button variant="outline" size="sm" onClick={() => void test()} disabled={testing}>{testing ? <Loader2 className="animate-spin" /> : <PlugZap />} Test connection</Button>
        </header>
        <form noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <SourceFields form={form} set={(patch) => setForm((current) => ({ ...current, ...patch }))} editing storedKeys={detail.data?.credentialKeys ?? []} />
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setForm(initialForm(source))} disabled={saving}>Reset</Button>
            <Button type="submit" disabled={saving || !form.name.trim() || !form.location.trim()}>{saving ? <Loader2 className="animate-spin" /> : <Check />} Save settings</Button>
          </div>
        </form>
      </section>
      <section className="rounded-card border border-destructive/30 p-4">
        <h2 className="text-sm font-semibold text-destructive">Delete source</h2>
        <p className="mt-1 text-xs text-muted-foreground">Removes it from Polpo with its stored credentials and agent grants. The database or file itself is not touched; views that read it stop working.</p>
        <Button variant="outline" size="sm" className="mt-3 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setConfirmDelete(true)}><Trash2 /> Delete source</Button>
      </section>
      <Dialog open={confirmDelete} onOpenChange={(value) => { if (!value && !deleting) setConfirmDelete(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {source.name}?</DialogTitle>
            <DialogDescription>Its credentials and grants are removed. The data stays where it is.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={deleting}>Cancel</Button>
            <Button variant="destructive" onClick={() => void remove()} disabled={deleting}>{deleting ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete source</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function NewSourceDialog({ open, registry, onClose, onCreated }: { open: boolean; registry: DataRegistry; onClose: () => void; onCreated: (source: DataSource) => void }) {
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b px-6 pb-4 pt-6 pr-12">
          <DialogTitle>Connect a data source</DialogTitle>
          <DialogDescription>A database, an API or a file agents can query. Credentials are encrypted in the Vault and never returned to the browser.</DialogDescription>
        </DialogHeader>
        {open && <NewSourceForm registry={registry} onClose={onClose} onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  );
}

function NewSourceForm({ registry, onClose, onCreated }: { registry: DataRegistry; onClose: () => void; onCreated: (source: DataSource) => void }) {
  const [form, setForm] = useState(() => initialForm());
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!form.name.trim() || !form.location.trim()) return;
    setSaving(true);
    try { onCreated(await saveSource(registry, toInput(form))); }
    catch (error) { toast.error(errorMessage(error)); }
    finally { setSaving(false); }
  };
  return (
    <DialogBody>
      <form noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <SourceFields form={form} set={(patch) => setForm((current) => ({ ...current, ...patch }))} editing={false} storedKeys={[]} />
        <DialogFooter sticky>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving || !form.name.trim() || !form.location.trim()}>{saving ? <Loader2 className="animate-spin" /> : <Check />} Connect source</Button>
        </DialogFooter>
      </form>
    </DialogBody>
  );
}
