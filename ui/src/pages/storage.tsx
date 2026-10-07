import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Check, ChevronRight, Cloud, FolderOpen, KeyRound, Loader2, Plug, PlugZap, Plus, Search, ShieldCheck, Trash2, Unplug, X,
} from "lucide-react";
import { toast } from "sonner";
import { useAgents } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useStorage,
  type KeyStatus,
  type MountState,
  type StorageTemporarySettings,
  type StorageDriver,
  type StorageEntry,
  type StorageEntryInput,
  type StorageGrant,
} from "@/hooks/use-storage";
import { cn } from "@/lib/utils";
import { VaultRefPicker } from "@/components/vault/vault-ref-picker";
import { describeVaultRef, type VaultRef } from "@/lib/vault-ref";

type EntryTab = "overview" | "access";
type Preset = "r2" | "aws" | "other";

const PRESETS: Array<{ id: Preset; label: string; description: string }> = [
  { id: "r2", label: "Cloudflare R2", description: "Account endpoint, region auto" },
  { id: "aws", label: "AWS S3", description: "Amazon S3 by region" },
  { id: "other", label: "Other S3-compatible", description: "MinIO, B2, Wasabi, Hetzner…" },
];

const R2_ENDPOINT = /^https:\/\/([a-z0-9]+)\.r2\.cloudflarestorage\.com\/?$/i;

export function StoragePage() {
  const storage = useStorage();
  const [params, setParams] = useSearchParams();
  const selected = storage.entries.find((entry) => entry.id === params.get("storage") || entry.slug === params.get("storage")) ?? storage.entries[0];
  const [dialog, setDialog] = useState<{ open: boolean; entry?: StorageEntry }>({ open: false });

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 bg-background">
      <div className="flex shrink-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">S3-compatible buckets mounted as folders for agents. Keys stay in an agent's vault; a bucket only references the entry.</p>
        </div>
        <Button size="sm" className="h-8" onClick={() => setDialog({ open: true })}><Plus className="h-3.5 w-3.5" /> Add bucket</Button>
      </div>

      {storage.error && <div className="border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{storage.error}</div>}
      {storage.loading ? <Loading /> : (
        <EntriesWorkspace
          storage={storage}
          entry={selected}
          onSelect={(entry) => setParams({ storage: entry.slug })}
          onEdit={(entry) => setDialog({ open: true, entry })}
          onAdd={() => setDialog({ open: true })}
        />
      )}
      <EntryDialog open={dialog.open} entry={dialog.entry} storage={storage} onClose={() => setDialog({ open: false })} onSaved={(entry) => setParams({ storage: entry.slug })} />
    </div>
  );
}

function EntriesWorkspace({ storage, entry, onSelect, onEdit, onAdd }: {
  storage: ReturnType<typeof useStorage>; entry?: StorageEntry; onSelect: (entry: StorageEntry) => void; onEdit: (entry: StorageEntry) => void; onAdd: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = storage.entries.filter((item) => `${item.name} ${item.slug} ${item.bucket} ${item.endpoint ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/15 xl:w-72">
        <div className="relative border-b border-border p-2">
          <Search className="absolute left-4 top-4 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a bucket" className="h-8 pl-8 text-xs" />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1.5">
          {filtered.map((item) => (
            <button key={item.id} onClick={() => onSelect(item)} className={cn("mb-1 flex w-full items-center gap-2 border px-2.5 py-2 text-left transition-colors", entry?.id === item.id ? "border-primary/40 bg-primary/5" : "border-transparent hover:bg-muted/60")}>
              <Cloud className="h-4 w-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{item.name}</span>
                <span className="block truncate text-[10px] text-muted-foreground">{bucketLabel(item)}</span>
              </span>
              <MountBadge entry={item} compact />
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            </button>
          ))}
          {filtered.length === 0 && <Empty compact title="No buckets found" />}
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-hidden">
        {entry ? <EntryDetail key={entry.id} entry={entry} storage={storage} onEdit={() => onEdit(entry)} /> : (
          <Empty title="Connect your first bucket" description="Cloudflare R2, AWS S3, MinIO or any S3-compatible storage. Agents see it as a folder and through the storage tools." action={<Button size="sm" className="mt-4 h-8" onClick={onAdd}><Plus className="h-3.5 w-3.5" /> Add bucket</Button>} />
        )}
      </main>
    </div>
  );
}

function EntryDetail({ entry, storage, onEdit }: { entry: StorageEntry; storage: ReturnType<typeof useStorage>; onEdit: () => void }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<EntryTab>("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mounted = entry.mount.state === "mounted";

  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    try { await action(); } catch (error) { toast.error(message(error)); } finally { setBusy(null); }
  };
  const test = () => run("test", async () => {
    const result = await storage.testEntry(entry.id);
    toast.success(`Connected in ${result.latencyMs}ms${result.sampleKey ? ` · found ${result.sampleKey}` : " · the bucket is empty"}`);
  });
  const toggleMount = () => run("mount", async () => {
    if (mounted) { await storage.unmountEntry(entry.id); toast.success(`${entry.name} unmounted`); }
    else { await storage.mountEntry(entry.id); toast.success(`${entry.name} mounted`); }
  });
  const remove = () => run("delete", async () => {
    await storage.deleteEntry(entry.id);
    setConfirmDelete(false);
    toast.success("Bucket removed");
  });
  const filesPath = mounted ? relativeToProject(entry.mount.path) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center border border-border bg-muted/30"><Cloud className="h-5 w-5 text-primary" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">{entry.name}</h2>
              <MountBadge entry={entry} />
              {entry.readOnly && <span className="border border-border px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">read-only</span>}
            </div>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{entry.description || bucketLabel(entry)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Button variant="outline" size="sm" className="h-8" onClick={() => void test()} disabled={busy === "test"}>{busy === "test" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />} Test connection</Button>
            <Button variant="outline" size="sm" className="h-8" onClick={() => void toggleMount()} disabled={busy === "mount" || (!mounted && !entry.enabled)}>
              {busy === "mount" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : mounted ? <Unplug className="h-3.5 w-3.5" /> : <PlugZap className="h-3.5 w-3.5" />}
              {mounted ? "Unmount" : "Mount"}
            </Button>
            <Button variant="ghost" size="sm" className="h-8" onClick={onEdit}>Settings</Button>
          </div>
        </div>
        <Tabs value={tab} onValueChange={(value) => setTab(value as EntryTab)} className="mt-4">
          <TabsList variant="line"><TabsTrigger value="overview">Overview</TabsTrigger><TabsTrigger value="access">Access</TabsTrigger></TabsList>
        </Tabs>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {tab === "overview" && (
          <div className="mx-auto max-w-4xl space-y-6">
            {entry.mount.state === "error" && entry.mount.error && (
              <div className="border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{entry.mount.error}</div>
            )}
            <section>
              <h3 className="text-xs font-semibold">Connection</h3>
              <dl className="mt-3 divide-y divide-border border-y border-border">
                {[
                  ["Endpoint", entry.endpoint || `AWS S3 (${entry.region || "us-east-1"})`],
                  ["Region", entry.region || "—"],
                  ["Bucket", entry.bucket],
                  ["Prefix", entry.prefix || "Whole bucket"],
                  ["Addressing", entry.pathStyle === false ? "Virtual-hosted" : entry.pathStyle ? "Path style" : entry.endpoint ? "Path style" : "Virtual-hosted"],
                  ["Driver", entry.driver === "mountpoint-s3" ? "mountpoint-s3" : "rclone"],
                  ["Cache", `${entry.cache?.mode ?? "writes"} · ${entry.cache?.maxSizeMb ?? 1024} MB`],
                ].map(([label, value]) => (
                  <div key={label} className="grid grid-cols-[150px_1fr] gap-4 py-3 text-xs"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-all font-mono">{value}</dd></div>
                ))}
              </dl>
            </section>
            <section>
              <h3 className="text-xs font-semibold">Mount</h3>
              <dl className="mt-3 divide-y divide-border border-y border-border">
                <div className="grid grid-cols-[150px_1fr] gap-4 py-3 text-xs"><dt className="text-muted-foreground">State</dt><dd><MountBadge entry={entry} />{entry.mount.restarts > 0 && <span className="ml-2 text-[10px] text-muted-foreground">{entry.mount.restarts} restart{entry.mount.restarts === 1 ? "" : "s"}</span>}</dd></div>
                <div className="grid grid-cols-[150px_1fr] gap-4 py-3 text-xs"><dt className="text-muted-foreground">Folder on this server</dt><dd className="min-w-0 break-all font-mono">{entry.mount.path}</dd></div>
              </dl>
              {filesPath && <Button variant="outline" size="sm" className="mt-3 h-8" onClick={() => navigate(`/files?path=${encodeURIComponent(filesPath)}`)}><FolderOpen className="h-3.5 w-3.5" /> Browse in Files</Button>}
            </section>
            <section>
              <h3 className="text-xs font-semibold">Credentials</h3>
              <dl className="mt-3 divide-y divide-border border-y border-border">
                <div className="grid grid-cols-[150px_1fr] gap-4 py-3 text-xs"><dt className="text-muted-foreground">Access key</dt><dd><CredentialState value={entry.keys.credentials} source={entry.credentials} /></dd></div>
                {entry.temporaryCredentials
                  ? <div className="grid grid-cols-[150px_1fr] gap-4 py-3 text-xs"><dt className="text-muted-foreground">Sandbox key</dt><dd>Temporary keys per run ({entry.temporaryCredentials.kind === "r2" ? "Cloudflare R2" : "STS role"}){entry.temporaryCredentials.kind === "r2" && <> · API token <CredentialState value={entry.keys.temporaryToken} source={entry.temporaryCredentials.token} /></>}</dd></div>
                  : <div className="grid grid-cols-[150px_1fr] gap-4 py-3 text-xs"><dt className="text-muted-foreground">Sandbox key</dt><dd><CredentialState value={entry.keys.sandboxCredentials} source={entry.sandboxCredentials} /></dd></div>}
              </dl>
              <p className="mt-2 text-[10px] text-muted-foreground">Keys stay in the referenced vault entries (an agent's Credentials tab) and are never shown here.</p>
            </section>
            <section className="border-t border-border pt-5">
              <h3 className="text-xs font-semibold text-destructive">Danger zone</h3>
              <p className="mt-1 text-xs text-muted-foreground">Removing the bucket unmounts it. The files in the bucket and the vault entries are not touched.</p>
              <Button variant="outline" size="sm" className="mt-3 h-8 border-destructive/40 text-destructive hover:bg-destructive/10" onClick={() => setConfirmDelete(true)}><Trash2 className="h-3.5 w-3.5" /> Remove bucket</Button>
            </section>
          </div>
        )}
        {tab === "access" && (
          <div className="mx-auto max-w-4xl">
            <div className="mb-4 flex items-start gap-3 border border-border bg-muted/20 p-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 text-primary" />
              <div>
                <h3 className="text-xs font-semibold">Bucket-scoped access</h3>
                <p className="mt-1 text-[11px] text-muted-foreground">Agents without a grant do not see this bucket. A prefix limits an agent to one folder. The storage tools need "storage_*" among the agent's tools.</p>
              </div>
            </div>
            <div className="divide-y divide-border border-y border-border">
              {entry.grants.map((grant) => (
                <div key={grant.id ?? grant.agent} className="flex items-center gap-3 py-3">
                  <div className="flex h-8 w-8 items-center justify-center border border-border bg-muted/30 text-xs font-semibold">{grant.agent === "*" ? "*" : grant.agent.slice(0, 1).toUpperCase()}</div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">{grant.agent === "*" ? "All agents" : grant.agent}</div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">{grant.prefix || "Whole bucket"}</div>
                  </div>
                  <span className="border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">{entry.readOnly || grant.access === "read" ? "Read" : "Read & write"}</span>
                </div>
              ))}
              {entry.grants.length === 0 && <Empty compact title="No agent has access" />}
            </div>
            <Button variant="outline" size="sm" className="mt-3 h-8" onClick={onEdit}><KeyRound className="h-3.5 w-3.5" /> Edit access</Button>
          </div>
        )}
      </div>
      <Dialog open={confirmDelete} onOpenChange={(value) => { if (!value) setConfirmDelete(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {entry.name}?</DialogTitle>
            <DialogDescription>The bucket is unmounted and agents lose access. The files in the bucket and the vault entries with its keys are not deleted.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void remove()} disabled={busy === "delete"}>{busy === "delete" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Remove bucket</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EntryDialog({ open, entry, storage, onClose, onSaved }: {
  open: boolean; entry?: StorageEntry; storage: ReturnType<typeof useStorage>; onClose: () => void; onSaved: (entry: StorageEntry) => void;
}) {
  const { agents } = useAgents();
  const [preset, setPreset] = useState<Preset>("r2");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [accountId, setAccountId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("auto");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [pathStyle, setPathStyle] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [driver, setDriver] = useState<StorageDriver>("rclone");
  const [cacheMode, setCacheMode] = useState<"writes" | "full">("writes");
  const [cacheSize, setCacheSize] = useState("1024");
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

  useEffect(() => {
    if (!open) return;
    const r2 = entry?.endpoint ? R2_ENDPOINT.exec(entry.endpoint) : null;
    setPreset(!entry ? "r2" : r2 ? "r2" : entry.endpoint ? "other" : "aws");
    setName(entry?.name ?? ""); setDescription(entry?.description ?? "");
    setAccountId(r2?.[1] ?? ""); setEndpoint(entry?.endpoint ?? ""); setRegion(entry?.region ?? (entry ? "" : "auto"));
    setBucket(entry?.bucket ?? ""); setPrefix(entry?.prefix ?? ""); setPathStyle(entry?.pathStyle ?? true);
    setReadOnly(entry?.readOnly ?? false); setEnabled(entry?.enabled ?? true); setDriver(entry?.driver ?? "rclone");
    setCacheMode(entry?.cache?.mode ?? "writes"); setCacheSize(String(entry?.cache?.maxSizeMb ?? 1024));
    setCredentials(entry?.credentials ?? null); setSandboxCredentials(entry?.sandboxCredentials ?? null);
    const temp = entry?.temporaryCredentials;
    setKeyMode(temp ? "temporary" : "fixed");
    setTmpAccountId(temp?.kind === "r2" ? temp.accountId : r2?.[1] ?? ""); setTmpParentKey(temp?.kind === "r2" ? temp.parentAccessKeyId : ""); setTmpToken(temp?.kind === "r2" ? temp.token ?? null : null);
    setTmpRoleArn(temp?.kind === "sts" ? temp.roleArn : ""); setTmpEndpoint(temp?.kind === "sts" ? temp.endpoint ?? "" : "");
    setGrants(entry?.grants ?? []);
  }, [open, entry]);

  const choosePreset = (next: Preset) => {
    setPreset(next);
    if (next === "r2") { setRegion("auto"); setPathStyle(true); setEndpoint(accountId ? r2Endpoint(accountId) : ""); }
    if (next === "aws") { setRegion("us-east-1"); setPathStyle(false); setEndpoint(""); }
    if (next === "other") { setRegion("us-east-1"); setPathStyle(true); setEndpoint(""); }
  };
  const resolvedEndpoint = preset === "r2" ? (accountId.trim() ? r2Endpoint(accountId.trim()) : "") : preset === "aws" ? "" : endpoint.trim();
  const temporary: StorageTemporarySettings | null = keyMode === "fixed" ? null
    : preset === "r2"
      ? { kind: "r2", accountId: tmpAccountId.trim(), parentAccessKeyId: tmpParentKey.trim(), ...(tmpToken ? { token: tmpToken } : {}) }
      : { kind: "sts", roleArn: tmpRoleArn.trim(), ...(tmpEndpoint.trim() ? { endpoint: tmpEndpoint.trim() } : {}) };
  const temporaryIncomplete = !!temporary && (temporary.kind === "r2"
    ? !temporary.accountId || !temporary.parentAccessKeyId || !temporary.token
    : !temporary.roleArn);
  const missing = temporaryIncomplete || !name.trim() || !bucket.trim() || (preset === "r2" && !accountId.trim()) || (preset === "other" && !endpoint.trim())
    || !credentials || grants.some((grant) => !grant.agent);

  const save = async () => {
    if (missing) return;
    setSaving(true);
    const input: StorageEntryInput = {
      name: name.trim(), slug: entry?.slug ?? slugify(name), description: description.trim() || undefined,
      endpoint: resolvedEndpoint || undefined, region: region.trim() || undefined, bucket: bucket.trim(), prefix: prefix.trim() || undefined,
      pathStyle, driver: readOnly ? driver : "rclone", readOnly, enabled,
      cache: { mode: cacheMode, maxSizeMb: Math.max(64, Number(cacheSize) || 1024) },
      grants: grants.map((grant) => ({ ...grant, prefix: grant.prefix?.trim() || undefined })),
      credentials,
      // temporary keys replace the fixed sandbox key
      sandboxCredentials: keyMode === "fixed" ? sandboxCredentials : null,
      temporaryCredentials: temporary,
    };
    try {
      const saved = entry ? await storage.updateEntry(entry.id, input) : await storage.createEntry(input);
      toast.success(entry ? "Bucket updated" : "Bucket added");
      onSaved(saved);
      onClose();
      if (saved.mount.state === "error" && saved.mount.error) toast.warning(`Saved, but not mounted: ${saved.mount.error}`);
      else if (!entry) void storage.testEntry(saved.id).then((result) => toast.success(`Connection verified in ${result.latencyMs}ms`)).catch((error) => toast.warning(`Saved, but the connection test failed: ${message(error)}`));
    } catch (error) { toast.error(message(error)); } finally { setSaving(false); }
  };

  const agentOptions = [{ value: "*", label: "All agents" }, ...agents.map((agent) => ({ value: agent.name, label: agent.identity?.displayName ?? agent.name }))];

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-auto">
        <DialogHeader>
          <DialogTitle>{entry ? "Bucket settings" : "Add a bucket"}</DialogTitle>
          <DialogDescription>Keys stay in an agent's vault (shared with others if needed): choose the entries that hold them.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div>
            <span className="text-xs font-medium">Provider</span>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {PRESETS.map((item) => (
                <button key={item.id} type="button" onClick={() => choosePreset(item.id)} className={cn("border p-2 text-left", preset === item.id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50")}>
                  <Cloud className="h-4 w-4 text-primary" />
                  <span className="mt-2 block text-[11px] font-medium">{item.label}</span>
                  <span className="block text-[10px] text-muted-foreground">{item.description}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Shared documents" /></Field>
            <Field label="Bucket"><Input value={bucket} onChange={(event) => setBucket(event.target.value)} className="font-mono" placeholder="my-bucket" /></Field>
          </div>
          <Field label="Description"><Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this bucket contains" /></Field>
          {preset === "r2" && <Field label="Cloudflare account ID"><Input value={accountId} onChange={(event) => setAccountId(event.target.value)} className="font-mono" placeholder="0123456789abcdef0123456789abcdef" /></Field>}
          {preset === "other" && <Field label="Endpoint"><Input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} className="font-mono" placeholder="https://s3.example.com" /></Field>}
          {resolvedEndpoint && preset === "r2" && <p className="-mt-2 font-mono text-[10px] text-muted-foreground">{resolvedEndpoint}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Region"><Input value={region} onChange={(event) => setRegion(event.target.value)} className="font-mono" placeholder={preset === "r2" ? "auto" : "us-east-1"} /></Field>
            <Field label="Prefix (optional)"><Input value={prefix} onChange={(event) => setPrefix(event.target.value)} className="font-mono" placeholder="team/shared/" /></Field>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <Toggle label="Path-style URLs" hint="Needed by MinIO and most self-hosted servers" checked={pathStyle} onChange={setPathStyle} />
            <Toggle label="Read-only" hint="Agents can never write" checked={readOnly} onChange={(value) => { setReadOnly(value); if (!value) setDriver("rclone"); }} />
            <Toggle label="Mounted" hint="Mount on this server at start" checked={enabled} onChange={setEnabled} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Mount driver">
              <Select value={driver} onValueChange={(value) => setDriver(value as StorageDriver)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="rclone">rclone (recommended)</SelectItem>
                  <SelectItem value="mountpoint-s3" disabled={!readOnly}>mountpoint-s3 (read-only)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Cache">
              <Select value={cacheMode} onValueChange={(value) => setCacheMode(value as "writes" | "full")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="writes">Writes</SelectItem>
                  <SelectItem value="full">Reads and writes</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Cache size (MB)"><Input value={cacheSize} onChange={(event) => setCacheSize(event.target.value)} type="number" min={64} /></Field>
          </div>

          <section className="grid gap-3 border-t border-border pt-4">
            <div>
              <h3 className="text-xs font-semibold">Access key</h3>
              <p className="mt-1 text-[11px] text-muted-foreground">The vault entry with the access key ID and secret: used on this server to mount the bucket and by the storage tools.</p>
            </div>
            <PickerField label="Vault entry">
              <VaultRefPicker value={credentials} onChange={setCredentials} requiredKeys={["accessKeyId", "secretAccessKey"]} placeholder="Choose the vault entry with the access key" aria-label="Access key vault entry" />
            </PickerField>
          </section>

          <section className="grid gap-3 border-t border-border pt-4">
            <div>
              <h3 className="text-xs font-semibold">Sandbox key (optional)</h3>
              <p className="mt-1 text-[11px] text-muted-foreground">Remote sandboxes mount the bucket themselves, so they need a key inside the sandbox. Use a fixed key limited to this bucket (and prefix), or let Polpo mint temporary keys for each task run. Never your main key as a fixed key. Without either, the bucket is not mounted in remote sandboxes.</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {([["fixed", "Fixed key", "One dedicated key, in a vault entry."], ["temporary", "Temporary keys per run", "Minted per task, limited to the agent's prefix, expire with the task."]] as const).map(([id, title, text]) => (
                <button key={id} type="button" onClick={() => setKeyMode(id)} className={cn("border p-2 text-left", keyMode === id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50")}>
                  <span className="block text-xs font-medium">{title}</span><span className="block text-[11px] text-muted-foreground">{text}</span>
                </button>
              ))}
            </div>
            {keyMode === "fixed" && (<>
            <PickerField label="Vault entry (optional)">
              <VaultRefPicker value={sandboxCredentials} onChange={setSandboxCredentials} requiredKeys={["accessKeyId", "secretAccessKey"]} placeholder="Optional: the vault entry with the sandbox key" aria-label="Sandbox key vault entry" />
            </PickerField>
            </>)}
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

          <section className="grid gap-3 border-t border-border pt-4">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="text-xs font-semibold">Agent access</h3>
                <p className="mt-1 text-[11px] text-muted-foreground">Only agents listed here see the bucket. A prefix limits an agent to one folder.</p>
              </div>
              <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => setGrants((current) => [...current, { agent: "", access: "read" }])}><Plus className="h-3.5 w-3.5" /> Add agent</Button>
            </div>
            {grants.map((grant, index) => (
              <div key={grant.id ?? `new-${index}`} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_130px_1fr_auto]">
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
                <Input value={grant.prefix ?? ""} onChange={(event) => setGrants((current) => current.map((item, i) => (i === index ? { ...item, prefix: event.target.value } : item)))} className="h-8 font-mono text-xs" placeholder="Prefix, e.g. clients/acme/" />
                <Button type="button" size="icon" variant="ghost" className="h-8 w-8" aria-label="Remove access" onClick={() => setGrants((current) => current.filter((_, i) => i !== index))}><X className="h-3.5 w-3.5" /></Button>
              </div>
            ))}
            {grants.length === 0 && <p className="text-[11px] text-muted-foreground">No agent has access yet.</p>}
          </section>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || !!missing}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{entry ? "Save changes" : "Add bucket"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const MOUNT_STYLES: Record<MountState | "disabled", { label: string; dot: string }> = {
  mounted: { label: "Mounted", dot: "bg-emerald-500" },
  mounting: { label: "Mounting", dot: "bg-amber-500" },
  unmounted: { label: "Not mounted", dot: "bg-muted-foreground/40" },
  error: { label: "Error", dot: "bg-destructive" },
  disabled: { label: "Disabled", dot: "bg-muted-foreground/40" },
};

function MountBadge({ entry, compact }: { entry: StorageEntry; compact?: boolean }) {
  const state = !entry.enabled && entry.mount.state === "unmounted" ? "disabled" : entry.mount.state;
  const style = MOUNT_STYLES[state];
  if (compact) return <span className={cn("h-2 w-2 shrink-0", style.dot)} title={style.label} />;
  return <span className="inline-flex items-center gap-1.5 border border-border px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground"><span className={cn("h-1.5 w-1.5", style.dot)} />{style.label}</span>;
}

function CredentialState({ value, source }: { value: KeyStatus; source?: VaultRef }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      {value === "set"
        ? <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><Check className="h-3 w-3" /> Set</span>
        : <span className="text-muted-foreground">{source ? "Not found in the vault" : "Not set"}</span>}
      {source && <span className="font-mono text-[10px] text-muted-foreground">{describeVaultRef(source)}</span>}
    </span>
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

function bucketLabel(entry: StorageEntry) {
  const host = entry.endpoint ? entry.endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "") : `s3.${entry.region || "us-east-1"}.amazonaws.com`;
  return `${host}/${entry.bucket}${entry.prefix ? `/${entry.prefix.replace(/^\/+/, "")}` : ""}`;
}
/** The Files page addresses .polpo paths relative to the project (".polpo/mounts/<slug>"). */
function relativeToProject(path: string) { const index = path.lastIndexOf("/.polpo/"); return index >= 0 ? path.slice(index + 1) : path; }
function r2Endpoint(accountId: string) { return `https://${accountId}.r2.cloudflarestorage.com`; }
/** Like Field, but not a <label>: the picker holds its own buttons and links. */
function PickerField({ label, children }: { label: string; children: React.ReactNode }) { return <div className="grid gap-1.5"><span className="text-xs font-medium">{label}</span>{children}</div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="grid gap-1.5"><span className="text-xs font-medium">{label}</span>{children}</label>; }
function Loading() { return <div className="flex min-h-0 flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>; }
function Empty({ title, description, compact, action }: { title: string; description?: string; compact?: boolean; action?: React.ReactNode }) {
  return <div className={cn("flex min-h-0 flex-1 flex-col items-center justify-center text-center", compact ? "px-3 py-8" : "h-full p-10")}><Cloud className="h-6 w-6 text-muted-foreground/50" /><h3 className="mt-3 text-sm font-medium">{title}</h3>{description && <p className="mt-1 max-w-sm text-xs text-muted-foreground">{description}</p>}{action}</div>;
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function slugify(value: string) { return value.toLocaleLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `storage-${Date.now()}`; }
