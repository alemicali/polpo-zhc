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
import { Textarea } from "@/components/ui/textarea";
import { NETWORK_MODES } from "@/lib/sandbox-api";
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
                <option value="daytona">Daytona (v0: stops when idle; v2: hibernates, wakes in a few seconds)</option>
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
          {kind !== "host" && (
            <div className="space-y-2" data-testid="computer-network-fields">
              <Field label="Network" hint={NETWORK_MODES.find((m) => m.id === form.networkMode)?.description ?? "The agent's rule, else the instance's (Settings → Sandbox)"}>
                <select className={selectClass} value={form.networkMode} onChange={(e) => set("networkMode", e.target.value as ComputerForm["networkMode"])} aria-label="Network">
                  <option value="">Inherited (agent or instance)</option>
                  {NETWORK_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </Field>
              {form.networkMode === "allowlist" && (
                <Field label="Allowed hosts" hint="One per line; *.example.com covers subdomains" error={visible.networkAllow}>
                  <Textarea rows={3} value={form.networkAllow} onChange={(e) => set("networkAllow", e.target.value)} placeholder={"github.com\n*.npmjs.org"} aria-label="Allowed hosts" aria-invalid={!!visible.networkAllow} />
                </Field>
              )}
            </div>
          )}
          {kind === "daytona" && (
            <div className="grid grid-cols-3 gap-2" data-testid="computer-resource-fields">
              <Field label="CPU" error={visible.cpus}>
                <Input inputMode="decimal" value={form.cpus} onChange={(e) => set("cpus", e.target.value)} placeholder="default" aria-label="CPU" aria-invalid={!!visible.cpus} />
              </Field>
              <Field label="Memory (GB)" error={visible.memoryGb}>
                <Input inputMode="decimal" value={form.memoryGb} onChange={(e) => set("memoryGb", e.target.value)} placeholder="default" aria-label="Memory (GB)" aria-invalid={!!visible.memoryGb} />
              </Field>
              <Field label="Disk (GB)" error={visible.diskGb}>
                <Input inputMode="decimal" value={form.diskGb} onChange={(e) => set("diskGb", e.target.value)} placeholder="default" aria-label="Disk (GB)" aria-invalid={!!visible.diskGb} />
              </Field>
              <p className="col-span-3 -mt-1 text-xs text-muted-foreground">With a Docker image (a snapshot has its own size). Size, image and network apply to a new machine (Reset); on Daytona v2 the network applies at the next start or wake.</p>
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
          <DialogFooter className="sticky -bottom-6 -mb-6 bg-background pb-6 pt-3">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />}{editing ? "Save" : "Create"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
