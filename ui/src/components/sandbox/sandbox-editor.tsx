/**
 * SandboxEditor — one level of the sandbox cascade (instance defaults or one agent's overrides).
 * Missions and tasks may only tighten what is set here; they are edited in the mission document.
 */
import { AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";
import { useStorage } from "@/hooks/use-storage";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { NetworkNotice } from "./network-notice";
import {
  NETWORK_MODES,
  SANDBOX_PROVIDERS,
  type SandboxNetworkMode,
  type SandboxProvider,
  type SandboxSettings,
  type SandboxVolumeSelection,
} from "@/lib/sandbox-api";

const INHERIT = "__inherit";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-foreground">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground leading-tight">{hint}</p>}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
          checked ? "bg-emerald-500/70" : "bg-white/[0.12]",
        )}
      >
        <span className={cn("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
          checked ? "translate-x-[1.125rem]" : "translate-x-0.5")} />
      </button>
      <span className="text-[12px] text-foreground/80">{label}</span>
    </div>
  );
}

function NumberInput({ value, onChange, placeholder }: { value?: number; onChange: (next?: number) => void; placeholder?: string }) {
  return (
    <Input
      type="number"
      min={0}
      inputMode="numeric"
      className="h-8 text-xs"
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => {
        const n = Number(e.target.value);
        onChange(e.target.value === "" || !Number.isFinite(n) || n <= 0 ? undefined : n);
      }}
    />
  );
}

export interface SandboxEditorProps {
  level: "instance" | "agent";
  value: SandboxSettings;
  onChange: (next: SandboxSettings) => void;
  /** Providers this server can run. */
  available: SandboxProvider[];
  /** Agent level: the agent has tools that read external content (web, email, messages). */
  readsExternalContent?: boolean;
  /** Agent level: the instance isolates agents that read external content. */
  confineExternal?: boolean;
  /** Agent level: the agent's name (the volumes it is granted). */
  agentName?: string;
}

export function SandboxEditor({ level, value, onChange, available, readsExternalContent, confineExternal, agentName }: SandboxEditorProps) {
  const set = (patch: Partial<SandboxSettings>) => onChange({ ...value, ...patch });
  const resources = value.resources ?? {};
  const setResource = (key: keyof NonNullable<SandboxSettings["resources"]>, n?: number) =>
    set({ resources: { ...resources, [key]: n } });
  const inheritable = level === "agent";

  return (
    <div className="space-y-5 max-w-xl">
      <Field
        label="Where tools run"
        hint={level === "instance"
          ? "Default for every agent and for Polpo's own commands. Chats always stay on this machine; remote sandboxes are for tasks."
          : "Overrides the instance default for this agent."}
      >
        <Select
          value={value.provider ?? INHERIT}
          onValueChange={(v) => set({ provider: v === INHERIT ? undefined : v as SandboxProvider })}
        >
          <SelectTrigger className="h-8 text-xs w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT} className="text-xs">
              {inheritable ? "Inherit from instance" : "This machine, no isolation (default)"}
            </SelectItem>
            {SANDBOX_PROVIDERS.map((p) => (
              <SelectItem key={p.id} value={p.id} className="text-xs" disabled={!available.includes(p.id) && p.id !== value.provider}>
                {p.label}{!available.includes(p.id) ? " — not available on this server" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {value.provider && (
          <p className="text-[10px] text-muted-foreground leading-tight">
            {SANDBOX_PROVIDERS.find((p) => p.id === value.provider)?.description}
          </p>
        )}
      </Field>

      <Field label="Providers missions and tasks may pick" hint="A mission or a task can move to a stronger isolation among these, never to a weaker one. Empty: any.">
        <div className="flex flex-wrap gap-1.5">
          {SANDBOX_PROVIDERS.map((p) => {
            const on = value.allowedProviders?.includes(p.id) ?? false;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  const list = new Set(value.allowedProviders ?? []);
                  if (on) list.delete(p.id); else list.add(p.id);
                  set({ allowedProviders: SANDBOX_PROVIDERS.map((x) => x.id).filter((id) => list.has(id)) });
                }}
                className={cn(
                  "rounded-md border px-2 py-1 text-[11px] transition-colors",
                  on ? "border-primary/50 bg-primary/10 text-foreground" : "border-border/40 text-muted-foreground hover:text-foreground",
                )}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="Network" hint="Enforced by bubblewrap and stronger sandboxes, and by the browser tools. On this machine without isolation the network rule cannot be enforced: everything is reachable.">
        <Select
          value={value.network?.mode ?? INHERIT}
          onValueChange={(v) => set({ network: v === INHERIT ? undefined : { mode: v as SandboxNetworkMode, allow: value.network?.allow } })}
        >
          <SelectTrigger className="h-8 text-xs w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT} className="text-xs">{inheritable ? "Inherit from instance" : "Open (default)"}</SelectItem>
            {NETWORK_MODES.map((m) => (
              <SelectItem key={m.id} value={m.id} className="text-xs">{m.label} — {m.description}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <NetworkNotice mode={value.network?.mode} />
      </Field>

      {value.network?.mode === "allowlist" && (
        <Field label="Allowed hosts" hint="One per line: example.com, *.example.com (also covers example.com), or host:port such as github.com:22 for ssh. A name that resolves to a local or private address stays refused unless you write the IP itself.">
          <Textarea
            className="text-xs font-mono min-h-24"
            value={(value.network.allow ?? []).join("\n")}
            placeholder={"github.com\n*.npmjs.org\npypi.org"}
            onChange={(e) => set({ network: { mode: "allowlist", allow: e.target.value.split("\n").map((d) => d.trim()) } })}
          />
        </Field>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Memory (MB)"><NumberInput value={resources.memoryMb} onChange={(n) => setResource("memoryMb", n)} placeholder="—" /></Field>
        <Field label="CPUs"><NumberInput value={resources.cpus} onChange={(n) => setResource("cpus", n)} placeholder="—" /></Field>
        <Field label="Disk (MB)"><NumberInput value={resources.diskMb} onChange={(n) => setResource("diskMb", n)} placeholder="—" /></Field>
        <Field label="Timeout (min)"><NumberInput value={resources.timeoutMin} onChange={(n) => setResource("timeoutMin", n)} placeholder="—" /></Field>
      </div>
      <p className="-mt-3 text-[10px] text-muted-foreground leading-tight">
        Upper limits for each command. Missions and tasks can lower them, not raise them. Empty: no limit.
      </p>

      <VolumesField level={level} value={value} set={set} agentName={agentName} />

      <RemoteLifecycle level={level} value={value} set={set} available={available} />

      {level === "instance" && (
        <Field label="Close idle chat sandboxes after (minutes)" hint="Each person or agent chatting has its own workspace; it is closed after this idle time. Default 30.">
          <NumberInput value={value.chatIdleMinutes} onChange={(n) => set({ chatIdleMinutes: n })} placeholder="30" />
        </Field>
      )}

      {level === "instance" && (
        <div className="space-y-1.5">
          <Toggle
            checked={!!value.confineExternalContent}
            onChange={(next) => set({ confineExternalContent: next || undefined, allowLocal: next ? value.allowLocal : undefined })}
            label="Isolate agents that read external content"
          />
          <p className="text-[10px] text-muted-foreground leading-tight">
            Off: the sandbox applies only where you set it (here, on an agent, in a mission). On: Polpo and agents with web,
            email, messaging or search tools (or no tool list) run at least in bubblewrap, even when the default is this machine.
          </p>
        </div>
      )}

      {(level === "instance" ? !!value.confineExternalContent : (!!confineExternal && !!readsExternalContent) || !!value.allowLocal) && (
        <div className="space-y-1.5">
          <Toggle
            checked={!!value.allowLocal}
            onChange={(next) => set({ allowLocal: next || undefined })}
            label={level === "instance" ? "Let Polpo run commands without isolation" : "Allow running without isolation"}
          />
          <p className={cn(
            "flex items-start gap-1.5 text-[10px] leading-tight",
            value.allowLocal ? "text-amber-500" : "text-muted-foreground",
          )}>
            <AlertTriangle className="h-3 w-3 mt-px shrink-0" />
            {level === "instance"
              ? "Polpo reads messages from people and channels. Without isolation, a message crafted to look like an instruction could make it run commands with access to this server's keys and data."
              : "This agent reads content from outside (web, email or messages). It runs at least in bubblewrap unless you allow this — for example when it needs git push or the gh login."}
          </p>
          {value.allowLocal && <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-500">unconfined</Badge>}
        </div>
      )}
    </div>
  );
}

/**
 * Volumes (open Polpo): Storage entries enabled as volumes and granted to the agent, attached at
 * /volumes/<name>. The instance can preselect; an agent (and its missions and tasks) only narrow.
 */
function VolumesField({ level, value, set, agentName }: {
  level: "instance" | "agent";
  value: SandboxSettings;
  set: (patch: Partial<SandboxSettings>) => void;
  agentName?: string;
}) {
  const storage = useStorage();
  const candidates = storage.entries.filter((e) => e.volume?.enabled && (level === "instance" || e.grants.some((g) => g.agent === agentName || g.agent === "*")));
  const selected = value.volumes ?? [];
  if (!candidates.length && !selected.length) {
    return (
      <Field label="Volumes" hint="Persistent files in R2/S3, attached at /volumes/<name>.">
        <p className="text-[10px] text-muted-foreground leading-tight">
          No volume {level === "agent" ? "granted to this agent" : "yet"}: enable one on a bucket in <Link to="/storage" className="underline">Storage</Link> (Volume tab) and grant it.
        </p>
      </Field>
    );
  }
  const toggle = (name: string, on: boolean) => {
    const next = on ? [...selected, { name }] : selected.filter((v) => v.name !== name);
    set({ volumes: next.length ? next : undefined });
  };
  const update = (name: string, patch: Partial<SandboxVolumeSelection>) =>
    set({ volumes: selected.map((v) => v.name === name ? Object.fromEntries(Object.entries({ ...v, ...patch }).filter(([, x]) => x !== undefined)) as unknown as SandboxVolumeSelection : v) });
  return (
    <Field label="Volumes" hint="Attached at /volumes/<name> in this sandbox. Missions and tasks can only narrow the list. Nothing selected: inherit.">
      <div className="space-y-1.5">
        {candidates.map((e) => {
          const sel = selected.find((v) => v.name === e.slug);
          const rw = e.volume!.access === "read-write" && !e.readOnly;
          return (
            <div key={e.id} className="flex flex-wrap items-center gap-2 text-xs">
              <label className="flex min-w-0 flex-1 items-center gap-2">
                <input type="checkbox" checked={!!sel} onChange={(ev) => toggle(e.slug, ev.target.checked)} />
                <span className="font-mono truncate">/volumes/{e.slug}</span>
                <Badge variant="outline" className="text-[9px]">{e.volume!.strategy}</Badge>
              </label>
              {sel && rw && (
                <Select value={sel.access ?? "__max"} onValueChange={(v) => update(e.slug, { access: v === "__max" ? undefined : v as "read-only" | "read-write", ...(v === "read-only" ? { writeBack: undefined } : {}) })}>
                  <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__max" className="text-xs">As granted</SelectItem>
                    <SelectItem value="read-only" className="text-xs">Read only</SelectItem>
                  </SelectContent>
                </Select>
              )}
              {sel && rw && e.volume!.strategy === "hydrated" && sel.access !== "read-only" && (
                <Select value={sel.writeBack ?? "__default"} onValueChange={(v) => update(e.slug, { writeBack: v === "__default" ? undefined : v as "auto" | "manual" })}>
                  <SelectTrigger className="h-7 w-40 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default" className="text-xs">Write back as set</SelectItem>
                    <SelectItem value="manual" className="text-xs">Only on checkpoint</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
          );
        })}
        {selected.filter((v) => !candidates.some((e) => e.slug === v.name)).map((v) => (
          <div key={v.name} className="flex items-center gap-2 text-xs text-amber-500">
            <AlertTriangle className="h-3 w-3" /> <span className="font-mono">{v.name}</span> is not a volume granted here: runs fail until it is granted or removed.
            <button className="underline" onClick={() => toggle(v.name, false)}>Remove</button>
          </div>
        ))}
      </div>
    </Field>
  );
}

/** Remote VMs (Daytona, E2B): Cowork chats, isolation, stop/delete times, warm VMs. */
function RemoteLifecycle({ level, value, set, available }: {
  level: "instance" | "agent";
  value: SandboxSettings;
  set: (patch: Partial<SandboxSettings>) => void;
  available: SandboxProvider[];
}) {
  const remote = available.filter((p) => p === "daytona" || p === "e2b") as Array<"daytona" | "e2b">;
  if (!remote.length) return null;
  const lc = value.lifecycle ?? {};
  const setLc = (patch: Partial<NonNullable<SandboxSettings["lifecycle"]>>) => {
    const next = { ...lc, ...patch };
    for (const k of Object.keys(next) as Array<keyof typeof next>) if (next[k] === undefined) delete next[k];
    set({ lifecycle: Object.keys(next).length ? next : undefined });
  };
  const inherit = level === "agent";
  return (
    <div className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Remote VMs (Daytona, E2B)</div>

      <div className="space-y-1.5">
        <Toggle
          checked={!!value.chatRemote}
          onChange={(next) => set({ chatRemote: next || undefined })}
          label={level === "instance" ? "Chats can run on the remote VM (Cowork)" : "This agent's chats run on the remote VM (Cowork)"}
        />
        <p className="text-[10px] text-muted-foreground leading-tight">
          Off: chats stay on this machine (bubblewrap at most) and remote VMs are for tasks. On: when the provider above is Daytona or E2B,
          a chat gets its own VM; commands and file tools run there, files the agent puts in the chat's output folder come back after every command (persistent files: volumes), tools with keys stay here.
          The VM is suspended after a minute without tools and goes back to the pool when the chat is idle.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Isolation" hint="Reuse: a VM this agent released (dependencies kept, working folder reset). Fresh: a clean VM each run. Shared: one VM concurrent runs use together.">
          <Select value={value.isolation ?? "__inherit"} onValueChange={(v) => set({ isolation: v === "__inherit" ? undefined : v as "reuse" | "fresh" | "shared" })}>
            <SelectTrigger className="h-8 text-xs w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__inherit" className="text-xs">{inherit ? "Inherit from instance" : "Reuse (default)"}</SelectItem>
              <SelectItem value="reuse" className="text-xs">Reuse the agent's VM</SelectItem>
              <SelectItem value="fresh" className="text-xs">Fresh VM each run</SelectItem>
              <SelectItem value="shared" className="text-xs">Shared by concurrent runs</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="At the end" hint="Keep: back to the pool for the next run (stopped after idle, then deleted). Delete: gone when the run ends.">
          <Select value={lc.onRelease ?? "__inherit"} onValueChange={(v) => setLc({ onRelease: v === "__inherit" ? undefined : v as "pool" | "destroy" })}>
            <SelectTrigger className="h-8 text-xs w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__inherit" className="text-xs">{inherit ? "Inherit from instance" : "Keep for reuse (default)"}</SelectItem>
              <SelectItem value="pool" className="text-xs">Keep for reuse</SelectItem>
              <SelectItem value="destroy" className="text-xs">Delete</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Stop kept VMs after (minutes idle)" hint="A pooled VM nobody uses is stopped after this time (its files kept). Default 5. During a run, E2B VMs pause between tools by themselves.">
          <NumberInput value={lc.stopAfterIdleMinutes} onChange={(n) => setLc({ stopAfterIdleMinutes: n })} placeholder="5" />
        </Field>
        <Field label="Delete stopped VMs after (minutes)" hint="A stopped VM nobody reuses is deleted after this time. Default 30.">
          <NumberInput value={lc.deleteAfterStopMinutes} onChange={(n) => setLc({ deleteAfterStopMinutes: n })} placeholder="30" />
        </Field>
      </div>

      {level === "instance" && (
        <div className="grid grid-cols-2 gap-3">
          {remote.map((p) => (
            <Field key={p} label={`Warm ${p === "daytona" ? "Daytona" : "E2B"} VMs`} hint="Ready and suspended for the first run; they cost while they exist. 0: none.">
              <NumberInput
                value={value.warm?.[p] || undefined}
                onChange={(n) => {
                  const warm = { ...(value.warm ?? {}), [p]: n };
                  if (!n) delete warm[p];
                  set({ warm: Object.keys(warm).length ? warm : undefined });
                }}
                placeholder="0"
              />
            </Field>
          ))}
        </div>
      )}
    </div>
  );
}
