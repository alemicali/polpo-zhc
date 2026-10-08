/**
 * VolumeDialog — add or edit a volume from the Files page (the former Storage page).
 *
 * A volume is either a folder of this server inside the project ("local": it stays on the host,
 * sandboxes on this machine see it in place, remote ones never) or a bucket (S3, R2, MinIO…:
 * remote sandboxes attach it mounted or hydrated). One volume = one bucket with its own key, so a
 * key only ever opens that volume. Keys stay in an agent's vault; the volume only references them.
 */
import { useEffect, useState } from "react";
import { Check, Cloud, FolderOpen, Loader2, Plug, Plus, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { useAgents } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  useStorage,
  type StorageDriver,
  type StorageEntry,
  type StorageEntryInput,
  type StorageGrant,
  type StorageImportJob,
  type StorageTemporarySettings,
  type StorageVolume,
} from "@/hooks/use-storage";
import { cn } from "@/lib/utils";
import { VaultRefPicker } from "@/components/vault/vault-ref-picker";
import type { VaultRef } from "@/lib/vault-ref";

type Kind = "local" | "s3";
type Preset = "r2" | "aws" | "other";

const PRESETS: Array<{ id: Preset; label: string; description: string }> = [
  { id: "r2", label: "Cloudflare R2", description: "Account endpoint, region auto" },
  { id: "aws", label: "AWS S3", description: "Amazon S3 by region" },
  { id: "other", label: "Other S3-compatible", description: "MinIO, B2, Wasabi, Hetzner…" },
];

const R2_ENDPOINT = /^https:\/\/([a-z0-9]+)\.r2\.cloudflarestorage\.com\/?$/i;

export function VolumeDialog({ open, entry, projectRoot, storage, onClose, onSaved }: {
  open: boolean;
  /** Editing this volume; absent = a new one. */
  entry?: StorageEntry;
  /** The project's folder on this server (local volumes are folders inside it). */
  projectRoot?: string;
  storage: ReturnType<typeof useStorage>;
  onClose: () => void;
  onSaved?: (entry: StorageEntry) => void;
}) {
  const { agents } = useAgents();
  const [kind, setKind] = useState<Kind>("s3");
  const [localPath, setLocalPath] = useState("");
  const [preset, setPreset] = useState<Preset>("r2");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [accountId, setAccountId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("auto");
  const [bucket, setBucket] = useState("");
  const [pathStyle, setPathStyle] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [driver, setDriver] = useState<StorageDriver>("rclone");
  const [cacheMode, setCacheMode] = useState<"writes" | "full">("writes");
  const [cacheSize, setCacheSize] = useState("1024");
  const [strategy, setStrategy] = useState<StorageVolume["strategy"]>("mounted");
  const [writeBack, setWriteBack] = useState<"auto" | "manual">("auto");
  const [credentials, setCredentials] = useState<VaultRef | null>(null);
  const [sandboxCredentials, setSandboxCredentials] = useState<VaultRef | null>(null);
  const [keyMode, setKeyMode] = useState<"fixed" | "temporary">("fixed");
  const [tmpAccountId, setTmpAccountId] = useState("");
  const [tmpParentKey, setTmpParentKey] = useState("");
  const [tmpToken, setTmpToken] = useState<VaultRef | null>(null);
  const [tmpRoleArn, setTmpRoleArn] = useState("");
  const [tmpEndpoint, setTmpEndpoint] = useState("");
  const [grants, setGrants] = useState<StorageGrant[]>([]);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importSource, setImportSource] = useState("");
  const [importTarget, setImportTarget] = useState("");
  const [job, setJob] = useState<StorageImportJob | null>(null);

  useEffect(() => {
    if (!open) return;
    const r2 = entry?.endpoint ? R2_ENDPOINT.exec(entry.endpoint) : null;
    setKind(entry?.provider === "local" ? "local" : entry ? "s3" : "s3");
    setLocalPath(entry?.path ? relativeTo(projectRoot, entry.path) : "");
    setPreset(!entry ? "r2" : r2 ? "r2" : entry.endpoint ? "other" : "aws");
    setName(entry?.name ?? ""); setDescription(entry?.description ?? "");
    setAccountId(r2?.[1] ?? ""); setEndpoint(entry?.endpoint ?? ""); setRegion(entry?.region ?? (entry ? "" : "auto"));
    setBucket(entry?.bucket ?? ""); setPathStyle(entry?.pathStyle ?? true);
    setReadOnly(entry?.readOnly ?? false); setEnabled(entry?.enabled ?? true); setDriver(entry?.driver ?? "rclone");
    setCacheMode(entry?.cache?.mode ?? "writes"); setCacheSize(String(entry?.cache?.maxSizeMb ?? 1024));
    setStrategy(entry?.volume?.strategy ?? "mounted"); setWriteBack(entry?.volume?.writeBack ?? "auto");
    setCredentials(entry?.credentials ?? null); setSandboxCredentials(entry?.sandboxCredentials ?? null);
    const temp = entry?.temporaryCredentials;
    setKeyMode(temp ? "temporary" : "fixed");
    setTmpAccountId(temp?.kind === "r2" ? temp.accountId : r2?.[1] ?? ""); setTmpParentKey(temp?.kind === "r2" ? temp.parentAccessKeyId : ""); setTmpToken(temp?.kind === "r2" ? temp.token ?? null : null);
    setTmpRoleArn(temp?.kind === "sts" ? temp.roleArn : ""); setTmpEndpoint(temp?.kind === "sts" ? temp.endpoint ?? "" : "");
    setGrants(entry?.grants ?? []);
    setConfirmDelete(false); setJob(null); setImportSource(""); setImportTarget("");
  }, [open, entry, projectRoot]);

  useEffect(() => {
    if (!entry || !job || job.state !== "running") return;
    const timer = setInterval(() => {
      void storage.importStatus(entry.id, job.id).then((next) => {
        setJob(next);
        if (next.state === "done") toast.success(`Copied ${next.files ?? 0} file(s) into ${entry.name}`);
        if (next.state === "failed") toast.error(next.error ?? "The copy failed");
      }).catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [job, entry, storage]);

  const choosePreset = (next: Preset) => {
    setPreset(next);
    if (next === "r2") { setRegion("auto"); setPathStyle(true); setEndpoint(accountId ? r2Endpoint(accountId) : ""); }
    if (next === "aws") { setRegion("us-east-1"); setPathStyle(false); setEndpoint(""); }
    if (next === "other") { setRegion("us-east-1"); setPathStyle(true); setEndpoint(""); }
  };
  const local = kind === "local";
  const resolvedEndpoint = preset === "r2" ? (accountId.trim() ? r2Endpoint(accountId.trim()) : "") : preset === "aws" ? "" : endpoint.trim();
  const temporary: StorageTemporarySettings | null = keyMode === "fixed" ? null
    : preset === "r2"
      ? { kind: "r2", accountId: tmpAccountId.trim(), parentAccessKeyId: tmpParentKey.trim(), ...(tmpToken ? { token: tmpToken } : {}) }
      : { kind: "sts", roleArn: tmpRoleArn.trim(), ...(tmpEndpoint.trim() ? { endpoint: tmpEndpoint.trim() } : {}) };
  const temporaryIncomplete = !!temporary && (temporary.kind === "r2"
    ? !temporary.accountId || !temporary.parentAccessKeyId || !temporary.token
    : !temporary.roleArn);
  const slug = entry?.slug ?? slugify(name);
  // a volume name: starts with a letter, lowercase letters, digits and dashes
  const badName = !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug) || slug.length < 2 || slug.length > 63;
  const missing = !name.trim() || badName || grants.some((grant) => !grant.agent) || (local
    ? !localPath.trim()
    : temporaryIncomplete || !bucket.trim() || (preset === "r2" && !accountId.trim()) || (preset === "other" && !endpoint.trim()) || !credentials);

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    try { await action(); } catch (error) { toast.error(message(error)); } finally { setBusy(null); }
  };

  const save = async () => {
    if (missing) return;
    setSaving(true);
    const access: StorageVolume["access"] = readOnly ? "read-only" : "read-write";
    const input: StorageEntryInput = local
      ? {
          name: name.trim(), slug, description: description.trim() || undefined, provider: "local", path: localPath.trim(),
          bucket: "", driver: "rclone", readOnly, enabled: true,
          grants: grants.map((grant) => ({ ...grant, writeBack: undefined })),
          volume: { strategy: "mounted", access },
        }
      : {
          name: name.trim(), slug, description: description.trim() || undefined, provider: "s3",
          endpoint: resolvedEndpoint || undefined, region: region.trim() || undefined, bucket: bucket.trim(),
          // prefixes are not part of volumes anymore: an existing one is kept as it is
          prefix: entry?.prefix || undefined,
          pathStyle, driver: readOnly ? driver : "rclone", readOnly, enabled,
          cache: { mode: cacheMode, maxSizeMb: Math.max(64, Number(cacheSize) || 1024) },
          grants: grants.map((grant) => ({ ...grant, prefix: grant.prefix?.trim() || undefined })),
          credentials,
          // temporary keys replace the fixed sandbox key
          sandboxCredentials: keyMode === "fixed" ? sandboxCredentials : null,
          temporaryCredentials: temporary,
          volume: { strategy, access, ...(strategy === "hydrated" && !readOnly ? { writeBack } : {}) },
        };
    try {
      const saved = entry ? await storage.updateEntry(entry.id, input) : await storage.createEntry(input);
      toast.success(entry ? "Volume updated" : "Volume added");
      onSaved?.(saved);
      onClose();
      if (saved.mount.state === "error" && saved.mount.error) toast.warning(`Saved, but not mounted here: ${saved.mount.error}`);
      else if (!entry && !local) void storage.testEntry(saved.id).then((result) => toast.success(`Connection verified in ${result.latencyMs}ms`)).catch((error) => toast.warning(`Saved, but the connection test failed: ${message(error)}`));
    } catch (error) { toast.error(message(error)); } finally { setSaving(false); }
  };

  const test = () => run("test", async () => {
    const result = await storage.testEntry(entry!.id);
    toast.success(local ? "The folder exists" : `Connected in ${result.latencyMs}ms${result.sampleKey ? ` · found ${result.sampleKey}` : " · the bucket is empty"}`);
  });
  const remove = () => run("delete", async () => {
    await storage.deleteEntry(entry!.id);
    toast.success(local ? "Volume removed (the folder is not touched)" : "Volume removed (the bucket and its files are not touched)");
    onClose();
  });
  const startImport = () => run("import", async () => {
    setJob(await storage.importFolder(entry!.id, importSource.trim(), importTarget.trim() || undefined));
  });

  const agentOptions = [{ value: "*", label: "All agents" }, ...agents.map((agent) => ({ value: agent.name, label: agent.name }))];

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{entry ? `Volume ${entry.name}` : "Add a volume"}</DialogTitle>
          <DialogDescription>
            A folder of this server, or a bucket that sandboxes (also remote ones) can attach. Agents use only the volumes they are given.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div>
            <span className="text-xs font-medium">Type</span>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {([
                ["local", FolderOpen, "Folder on this server", "Inside the project. Stays here: agents on this machine see it, remote sandboxes do not."],
                ["s3", Cloud, "Bucket (R2, S3…)", "Its own bucket and key. Remote sandboxes attach it live or as a copy."],
              ] as const).map(([id, Icon, title, text]) => (
                <button key={id} type="button" disabled={!!entry && kind !== id} onClick={() => setKind(id)}
                  className={cn("border p-2 text-left disabled:opacity-40", kind === id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50")}>
                  <Icon className="h-4 w-4 text-primary" />
                  <span className="mt-2 block text-[11px] font-medium">{title}</span>
                  <span className="block text-[10px] text-muted-foreground">{text}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="listini" /></Field>
            <Field label="Description"><Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What it contains" /></Field>
          </div>
          {name.trim() && <p className={cn("-mt-2 font-mono text-[10px]", badName ? "text-destructive" : "text-muted-foreground")}>
            {badName ? "The name must start with a letter (lowercase letters, digits and dashes)" : local ? `Agents on this machine: ${localPath.trim() || "…"}` : `In sandboxes: /volumes/${slug}`}
          </p>}

          {local ? (
            <Field label="Folder (relative to the project)">
              <Input value={localPath} onChange={(event) => setLocalPath(event.target.value)} className="font-mono" placeholder="dev/progetto-x" />
            </Field>
          ) : (<>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {PRESETS.map((item) => (
                <button key={item.id} type="button" onClick={() => choosePreset(item.id)} className={cn("border p-2 text-left", preset === item.id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50")}>
                  <span className="block text-[11px] font-medium">{item.label}</span>
                  <span className="block text-[10px] text-muted-foreground">{item.description}</span>
                </button>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Bucket"><Input value={bucket} onChange={(event) => setBucket(event.target.value)} className="font-mono" placeholder="polpo-listini" /></Field>
              <Field label="Region"><Input value={region} onChange={(event) => setRegion(event.target.value)} className="font-mono" placeholder={preset === "r2" ? "auto" : "us-east-1"} /></Field>
            </div>
            {preset === "r2" && <Field label="Cloudflare account ID"><Input value={accountId} onChange={(event) => setAccountId(event.target.value)} className="font-mono" placeholder="0123456789abcdef0123456789abcdef" /></Field>}
            {preset === "other" && <Field label="Endpoint"><Input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} className="font-mono" placeholder="https://s3.example.com" /></Field>}
            {resolvedEndpoint && preset === "r2" && <p className="-mt-2 font-mono text-[10px] text-muted-foreground">{resolvedEndpoint}</p>}
          </>)}

          <div className="grid gap-2 sm:grid-cols-3">
            <Toggle label="Read-only" hint="Agents can never write" checked={readOnly} onChange={(value) => { setReadOnly(value); if (!value) setDriver("rclone"); }} />
            {!local && <Toggle label="Browse in Files" hint="Mount it on this server" checked={enabled} onChange={setEnabled} />}
            {!local && <Toggle label="Path-style URLs" hint="Needed by MinIO and most self-hosted servers" checked={pathStyle} onChange={setPathStyle} />}
          </div>

          {!local && (
            <section className="grid gap-3 border-t border-border pt-4">
              <div>
                <h3 className="text-xs font-semibold">In sandboxes</h3>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Live: files read and written in the bucket as they change. Copy: copied in when the run starts and written back at the end
                  (or only when the agent calls sandbox_volume_checkpoint); if someone else changed it meanwhile, the run's version goes to .conflicts/.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Mode">
                  <Select value={strategy} onValueChange={(value) => setStrategy(value as StorageVolume["strategy"])}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mounted">Live (mounted)</SelectItem>
                      <SelectItem value="hydrated">Copy (hydrated)</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {strategy === "hydrated" && !readOnly && (
                  <Field label="Write back">
                    <Select value={writeBack} onValueChange={(value) => setWriteBack(value as "auto" | "manual")}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">At the end of the run</SelectItem>
                        <SelectItem value="manual">Only on checkpoint</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                )}
                {strategy === "mounted" && (
                  <Field label="Mount driver">
                    <Select value={driver} onValueChange={(value) => setDriver(value as StorageDriver)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="rclone">rclone</SelectItem>
                        <SelectItem value="mountpoint-s3" disabled={!readOnly}>mountpoint-s3 (read-only)</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                )}
                <Field label="Cache on this server">
                  <Select value={cacheMode} onValueChange={(value) => setCacheMode(value as "writes" | "full")}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="writes">Writes</SelectItem>
                      <SelectItem value="full">Reads and writes</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            </section>
          )}

          {!local && (
            <section className="grid gap-3 border-t border-border pt-4">
              <div>
                <h3 className="text-xs font-semibold">Keys</h3>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  The vault entry with this bucket's access key ID and secret (used on this server). Remote sandboxes need a key inside the VM:
                  a fixed key limited to this bucket, or temporary keys minted per run. Without one, remote sandboxes cannot attach it.
                </p>
              </div>
              <PickerField label="Access key (vault entry)">
                <VaultRefPicker value={credentials} onChange={setCredentials} requiredKeys={["accessKeyId", "secretAccessKey"]} placeholder="Choose the vault entry with the access key" aria-label="Access key vault entry" />
              </PickerField>
              <div className="grid grid-cols-2 gap-2">
                {([["fixed", "Fixed sandbox key", "One key limited to this bucket, in a vault entry."], ["temporary", "Temporary keys per run", "Minted per run, expire with it."]] as const).map(([id, title, text]) => (
                  <button key={id} type="button" onClick={() => setKeyMode(id)} className={cn("border p-2 text-left", keyMode === id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50")}>
                    <span className="block text-xs font-medium">{title}</span><span className="block text-[11px] text-muted-foreground">{text}</span>
                  </button>
                ))}
              </div>
              {keyMode === "fixed" && (
                <PickerField label="Sandbox key (vault entry)">
                  <VaultRefPicker value={sandboxCredentials} onChange={setSandboxCredentials} requiredKeys={["accessKeyId", "secretAccessKey"]} placeholder="The vault entry with the sandbox key" aria-label="Sandbox key vault entry" />
                </PickerField>
              )}
              {keyMode === "temporary" && (preset === "r2" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Cloudflare account ID"><Input value={tmpAccountId} onChange={(event) => setTmpAccountId(event.target.value)} className="font-mono" autoComplete="off" /></Field>
                  <Field label="Parent access key ID"><Input value={tmpParentKey} onChange={(event) => setTmpParentKey(event.target.value)} className="font-mono" autoComplete="off" /></Field>
                  <PickerField label="Cloudflare API token">
                    <VaultRefPicker value={tmpToken} onChange={setTmpToken} requiredKeys={["apiToken"]} placeholder="Vault entry with the API token" aria-label="Cloudflare API token vault entry" />
                  </PickerField>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="IAM role ARN"><Input value={tmpRoleArn} onChange={(event) => setTmpRoleArn(event.target.value)} className="font-mono" autoComplete="off" placeholder="arn:aws:iam::123456789012:role/polpo-sandbox" /></Field>
                  <Field label="STS endpoint (optional)"><Input value={tmpEndpoint} onChange={(event) => setTmpEndpoint(event.target.value)} className="font-mono" autoComplete="off" placeholder={preset === "aws" ? "Default: AWS regional STS" : "Default: the bucket endpoint"} /></Field>
                </div>
              ))}
            </section>
          )}

          <section className="grid gap-3 border-t border-border pt-4">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="text-xs font-semibold">Agents</h3>
                <p className="mt-1 text-[11px] text-muted-foreground">Only these agents can use it (then they pick it in Agent → Sandbox → Volumes).</p>
              </div>
              <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => setGrants((current) => [...current, { agent: "", access: "read" }])}><Plus className="h-3.5 w-3.5" /> Add agent</Button>
            </div>
            {grants.map((grant, index) => (
              <div key={grant.id ?? `new-${index}`} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_140px_auto]">
                <Select value={grant.agent || undefined} onValueChange={(value) => setGrants((current) => current.map((item, i) => (i === index ? { ...item, agent: value } : item)))}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Choose an agent" /></SelectTrigger>
                  <SelectContent>
                    {agentOptions.filter((option) => option.value === grant.agent || !grants.some((other) => other.agent === option.value)).map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={readOnly ? "read" : grant.access} onValueChange={(value) => setGrants((current) => current.map((item, i) => (i === index ? { ...item, access: value as StorageGrant["access"] } : item)))}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read">Read</SelectItem>
                    <SelectItem value="write" disabled={readOnly}>Read & write</SelectItem>
                  </SelectContent>
                </Select>
                <Button type="button" size="icon" variant="ghost" className="h-8 w-8" aria-label="Remove access" onClick={() => setGrants((current) => current.filter((_, i) => i !== index))}><X className="h-3.5 w-3.5" /></Button>
              </div>
            ))}
            {grants.length === 0 && <p className="text-[11px] text-muted-foreground">No agent can use it yet.</p>}
          </section>

          {entry && !local && !entry.readOnly && (
            <section className="grid gap-3 border-t border-border pt-4">
              <div>
                <h3 className="text-xs font-semibold">Copy a folder into this bucket</h3>
                <p className="mt-1 text-[11px] text-muted-foreground">Moves existing files onto the volume. The folder (relative to the project) is not changed; node_modules, .venv and .git are skipped.</p>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <Input value={importSource} onChange={(event) => setImportSource(event.target.value)} placeholder="Folder, e.g. dev/my-project" className="h-8 font-mono text-xs" />
                <Input value={importTarget} onChange={(event) => setImportTarget(event.target.value)} placeholder="Into (optional), e.g. my-project/" className="h-8 font-mono text-xs" />
                <Button variant="outline" size="sm" className="h-8" onClick={() => void startImport()} disabled={!importSource.trim() || job?.state === "running"}>
                  {job?.state === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Copy
                </Button>
              </div>
              {job && (
                <p className={cn("text-[11px]", job.state === "failed" ? "text-destructive" : "text-muted-foreground")}>
                  {job.state === "running" ? `Copying… ${job.files ?? 0} file(s) so far` : job.state === "done" ? `Done: ${job.files ?? 0} file(s) copied` : `Failed: ${job.error ?? "unknown error"}`}
                </p>
              )}
            </section>
          )}
        </div>
        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <div className="flex gap-1">
            {entry && (confirmDelete
              ? <Button variant="destructive" size="sm" onClick={() => void remove()} disabled={busy === "delete"}>{busy === "delete" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Confirm remove</Button>
              : <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmDelete(true)}><Trash2 className="h-4 w-4" /> Remove</Button>)}
            {entry && <Button variant="ghost" size="sm" onClick={() => void test()} disabled={busy === "test"}>{busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />} Test</Button>}
          </div>
          <div className="flex gap-1">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={() => void save()} disabled={saving || !!missing}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{entry ? "Save changes" : "Add volume"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2 border p-2", checked ? "border-primary/40 bg-primary/5" : "border-border hover:bg-muted/50")}>
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="min-w-0"><span className="block text-[11px] font-medium">{label}</span><span className="block text-[10px] text-muted-foreground">{hint}</span></span>
    </label>
  );
}

function PickerField({ label, children }: { label: string; children: React.ReactNode }) { return <div className="grid gap-1.5"><span className="text-xs font-medium">{label}</span>{children}</div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="grid gap-1.5"><span className="text-xs font-medium">{label}</span>{children}</label>; }
function r2Endpoint(accountId: string) { return `https://${accountId}.r2.cloudflarestorage.com`; }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function slugify(value: string) { return value.toLocaleLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function relativeTo(root: string | undefined, path: string) { return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path; }
