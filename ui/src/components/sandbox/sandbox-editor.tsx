/**
 * SandboxEditor — one level of the sandbox cascade (instance defaults or one agent's overrides).
 * Missions and tasks may only tighten what is set here; they are edited in the mission document.
 */
import { AlertTriangle } from "lucide-react";
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
}

export function SandboxEditor({ level, value, onChange, available, readsExternalContent, confineExternal }: SandboxEditorProps) {
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
