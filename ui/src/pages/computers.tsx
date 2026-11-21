/**
 * Computers: the machines agents work on. "This server" is always there; a computer is a
 * persistent Daytona or E2B machine an agent keeps between chats and tasks (files, installed
 * tools, browser profile). Cards show the provider, live status, the agents using it, last use
 * and uptime (a rough cost signal), with Start / Stop / Restart / Reset / Delete. Machines stop
 * by themselves after their idle time and are never deleted automatically.
 * Live: `computer:changed` over SSE.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Loader2, Monitor, Pencil, Play, Plus, RotateCcw, RefreshCw, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/computers/status-badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useComputers } from "@/hooks/use-computers";
import {
  EMPTY_COMPUTER_FORM, KIND_LABELS, availableActions, computerInput, computersApi, formFromComputer, formatLastUsed, formatUptime,
  validateComputerForm,
  type Computer, type ComputerAction, type ComputerForm, type ComputerKind,
} from "@/lib/computers-api";

const ACTION_META: Record<ComputerAction, { label: string; icon: typeof Play }> = {
  start: { label: "Start", icon: Play },
  stop: { label: "Stop", icon: Square },
  restart: { label: "Restart", icon: RefreshCw },
  reset: { label: "Reset", icon: RotateCcw },
};

function ComputerCard({
  computer, busy, onAction, onEdit, onDelete,
}: { computer: Computer; busy: boolean; onAction: (a: ComputerAction) => void; onEdit: () => void; onDelete: () => void }) {
  const image = computer.snapshot ? `snapshot ${computer.snapshot}` : computer.image ? `image ${computer.image}` : computer.template ? `template ${computer.template}` : null;
  return (
    <div data-testid={`computer-card-${computer.id}`} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40"><Monitor className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium leading-tight">{computer.name}</p>
          <p className="truncate text-xs text-muted-foreground">{KIND_LABELS[computer.kind]}{computer.builtin ? "" : ` · ${computer.id}`}{image ? ` · ${image}` : ""}</p>
        </div>
        <StatusBadge computer={computer} />
      </div>
      {computer.lastError && computer.status === "error" && <p className="text-xs text-destructive" role="alert">{computer.lastError}</p>}
      {computer.snapshotState && computer.snapshotState !== "active" && (
        <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="computer-snapshot">
          Snapshot {computer.snapshotState}{computer.snapshotState === "inactive" ? ": it is activated on the next start (a few minutes longer)" : ""}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Agents</dt>
        <dd className="truncate" data-testid="computer-agents">
          {computer.agents.length ? computer.agents.map((a) => `${a.name}${a.isDefault || computer.builtin ? "" : " (may use)"}`).join(", ") : "none"}
        </dd>
        {!computer.builtin && (
          <>
            <dt className="text-muted-foreground">Last used</dt><dd>{formatLastUsed(computer.lastUsedAt)}</dd>
            <dt className="text-muted-foreground">Uptime</dt><dd title="Time it ran (what the provider bills, roughly)">{formatUptime(computer.uptimeMinutes)}</dd>
            <dt className="text-muted-foreground">Stops after</dt><dd>{computer.lifecycle?.idleStopMinutes ?? 15} idle min</dd>
          </>
        )}
      </dl>
      {computer.builtin ? (
        <p className="mt-auto text-xs text-muted-foreground">
          Agents without a computer work here, in the sandbox set in <Link to="/config?section=sandbox" className="underline">Settings → Sandbox</Link>.
        </p>
      ) : (
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          {availableActions(computer).map((action) => {
            const { label, icon: Icon } = ACTION_META[action];
            return (
              <Button key={action} size="sm" variant={action === "start" ? "default" : "outline"} className="h-7 px-2.5 text-xs" disabled={busy}
                onClick={() => onAction(action)} aria-label={`${label} ${computer.name}`}>
                <Icon className="h-3.5 w-3.5" /> {label}
              </Button>
            );
          })}
          <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" disabled={busy} onClick={onEdit} aria-label={`Edit ${computer.name}`}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" disabled={busy} onClick={onDelete} aria-label={`Delete ${computer.name}`}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {error ? <span className="block text-xs text-destructive">{error}</span> : hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

const selectClass = "h-9 w-full rounded-md border bg-transparent px-2 text-sm";

export function ComputerDialog({
  open, onOpenChange, editing, existingIds, onSaved,
}: { open: boolean; onOpenChange: (open: boolean) => void; editing?: Computer; existingIds: string[]; onSaved: (c: Computer) => void }) {
  const [form, setForm] = useState<ComputerForm>(editing ? formFromComputer(editing) : EMPTY_COMPUTER_FORM);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const errors = validateComputerForm(form, existingIds, !!editing);
  const visible = showErrors ? errors : {};
  const set = <K extends keyof ComputerForm>(key: K, value: ComputerForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async () => {
    if (Object.keys(errors).length) { setShowErrors(true); return; }
    setSaving(true);
    try {
      const saved = editing
        ? await computersApi.update(editing.id, computerInput(form, true))
        : await computersApi.create(computerInput(form) as never);
      toast.success(editing ? `Saved ${saved.name}` : `Created ${saved.name}`);
      if (saved.note) toast.info(saved.note);
      onSaved(saved);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const kind = form.kind;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.name}` : "New computer"}</DialogTitle>
          <DialogDescription>
            A machine an agent keeps between chats and tasks: its files, installed tools and browser profile stay. It stops by itself
            when nobody uses it and is never deleted automatically.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {!editing && (
            <Field label="Id" hint="Lowercase letters, digits and -" error={visible.id}>
              <Input value={form.id} onChange={(e) => set("id", e.target.value.toLowerCase())} placeholder="nina" aria-invalid={!!visible.id} />
            </Field>
          )}
          <Field label="Name">
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={form.id || "Nina"} />
          </Field>
          {!editing && (
            <Field label="Runs on">
              <select className={selectClass} value={kind} onChange={(e) => set("kind", e.target.value as ComputerKind)} aria-label="Runs on">
                <option value="daytona">Daytona (v0: stops when idle; v2: Linux VM, pauses with memory)</option>
                <option value="e2b">E2B (pauses when idle, memory kept)</option>
                <option value="host">This server</option>
              </select>
            </Field>
          )}
          {kind === "daytona" && (
            <div className="grid grid-cols-[8rem_1fr] gap-2">
              <Field label="From">
                <select className={selectClass} value={form.imageKind} onChange={(e) => set("imageKind", e.target.value as "snapshot" | "image")} aria-label="From">
                  <option value="snapshot">Snapshot</option>
                  <option value="image">Docker image</option>
                </select>
              </Field>
              <Field label={form.imageKind === "snapshot" ? "Snapshot" : "Image"} hint={form.imageKind === "snapshot" ? "Daytona v0. Empty: the instance's (Settings → Sandbox)" : "v0: a Docker image (node:22); v2: an image of your Daytona project"}>
                <Input value={form.image} onChange={(e) => set("image", e.target.value)} placeholder={form.imageKind === "snapshot" ? "polpo-runner-…" : "node:22"} />
              </Field>
            </div>
          )}
          {kind === "e2b" && (
            <Field label="Template" hint="Empty: the instance's (Settings → Sandbox)">
              <Input value={form.image} onChange={(e) => set("image", e.target.value)} placeholder="polpo-runner-…" />
            </Field>
          )}
          {kind !== "host" && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Stop after (idle minutes)" error={visible.idleStopMinutes}>
                <Input inputMode="numeric" value={form.idleStopMinutes} onChange={(e) => set("idleStopMinutes", e.target.value)} aria-invalid={!!visible.idleStopMinutes} />
              </Field>
              {kind === "daytona" && (
                <Field label="Archive after (days stopped)" hint="Daytona v0 only. Empty: Daytona's (7)" error={visible.autoArchiveDays}>
                  <Input inputMode="numeric" value={form.autoArchiveDays} onChange={(e) => set("autoArchiveDays", e.target.value)} aria-invalid={!!visible.autoArchiveDays} />
                </Field>
              )}
            </div>
          )}
          {kind === "host" && (
            <Field label="Egress proxy" hint="The browser of its agents goes out through this proxy (a name from settings.egressProxies)">
              <Input value={form.egress} onChange={(e) => set("egress", e.target.value)} placeholder="home" />
            </Field>
          )}
          {!editing && kind !== "host" && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.start} onChange={(e) => set("start", e.target.checked)} />
              Create the machine now (otherwise on first use)
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />}{editing ? "Save" : "Create"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Pending = { computer: Computer; what: "reset" | "delete" };

export function ComputersPage() {
  const { computers, loading, error, refresh, upsert, drop } = useComputers();
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ editing?: Computer } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const run = async (computer: Computer, action: ComputerAction) => {
    if (action === "reset") { setPending({ computer, what: "reset" }); return; }
    setBusy(computer.id);
    try {
      upsert(await computersApi.control(computer.id, action));
    } catch (e) {
      toast.error((e as Error).message);
      void refresh(false);
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (!pending) return;
    const { computer, what } = pending;
    setPending(null);
    setBusy(computer.id);
    try {
      if (what === "reset") upsert(await computersApi.control(computer.id, "reset"));
      else { await computersApi.remove(computer.id); drop(computer.id); toast.success(`Deleted ${computer.name}`); }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 overflow-y-auto p-4 pb-bottom-nav sm:p-6 lg:pb-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold"><Monitor className="h-5 w-5" /> Computers</h1>
          <p className="text-sm text-muted-foreground">
            Machines agents keep between chats and tasks. Choose an agent's computer in its Sandbox tab.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={() => void refresh(true)} aria-label="Refresh status"><RefreshCw className="h-4 w-4" /></Button>
          <Button onClick={() => setDialog({})}><Plus className="h-4 w-4" /> New computer</Button>
        </div>
      </header>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          {error}
          <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => void refresh(true)}>Retry</Button>
        </div>
      )}

      {loading ? (
        <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading computers…</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {computers.map((c) => (
            <ComputerCard key={c.id} computer={c} busy={busy === c.id}
              onAction={(a) => void run(c, a)} onEdit={() => setDialog({ editing: c })} onDelete={() => setPending({ computer: c, what: "delete" })} />
          ))}
          {computers.filter((c) => !c.builtin).length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center">
              <p className="font-medium">No computers yet</p>
              <p className="text-sm text-muted-foreground">Give an agent its own machine: what it installs and saves is there next time.</p>
              <Button size="sm" onClick={() => setDialog({})}><Plus className="h-4 w-4" /> New computer</Button>
            </div>
          )}
        </div>
      )}

      {dialog && (
        <ComputerDialog
          key={dialog.editing?.id ?? "new"}
          open
          onOpenChange={(open) => { if (!open) setDialog(null); }}
          editing={dialog.editing}
          existingIds={computers.map((c) => c.id)}
          onSaved={(c) => { upsert(c); void refresh(false); }}
        />
      )}

      <Dialog open={!!pending} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{pending?.what === "reset" ? `Reset ${pending.computer.name}?` : `Delete ${pending?.computer.name}?`}</DialogTitle>
            <DialogDescription>
              {pending?.what === "reset"
                ? "Its machine is deleted and a new one is created: everything on its disk (files, installed tools, browser sign-ins) is lost."
                : "The computer and its machine are deleted, with everything on its disk. This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void confirm()}>{pending?.what === "reset" ? "Reset" : "Delete"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
