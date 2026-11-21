/**
 * Create / edit a computer. Shared by the Computers page and the agent's Computer tab, which
 * prefills it (`initial`: the agent's name as id and name) and adds its own fields (children).
 */
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  EMPTY_COMPUTER_FORM, computerInput, computersApi, formFromComputer, validateComputerForm,
  type Computer, type ComputerForm, type ComputerKind,
} from "@/lib/computers-api";

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
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
  open, onOpenChange, editing, initial, existingIds, onSaved, children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: Computer;
  /** Prefill for a new computer. */
  initial?: Partial<ComputerForm>;
  existingIds: string[];
  /** Awaited before the dialog closes (e.g. to assign the new computer to an agent). */
  onSaved: (c: Computer) => void | Promise<void>;
  /** Extra fields above the buttons. */
  children?: ReactNode;
}) {
  const [form, setForm] = useState<ComputerForm>(editing ? formFromComputer(editing) : { ...EMPTY_COMPUTER_FORM, ...initial });
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
      await onSaved(saved);
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
                <option value="daytona">Daytona (v0: stops when idle; not on v2)</option>
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
          <Field
            label="Egress proxy"
            hint={kind === "host"
              ? "The browser of its agents goes out through this proxy (a name from settings.egressProxies)"
              : "Optional. Its browser goes out through this proxy, reached through Tailscale inside the VM (needs settings.tailscale and a SOCKS5 proxy on a tailnet address)"}
          >
            <Input value={form.egress} onChange={(e) => set("egress", e.target.value)} placeholder="home" />
          </Field>
          {!editing && kind !== "host" && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.start} onChange={(e) => set("start", e.target.checked)} />
              Create the machine now (otherwise on first use)
            </label>
          )}
          {children}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />}{editing ? "Save" : "Create"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
