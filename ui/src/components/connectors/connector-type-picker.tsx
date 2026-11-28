/**
 * The connector type, picked when a connector is added (catalog and custom): the organization's,
 * one agent's own (Personal), or per identity (each agent / person connects its own accounts).
 */
import { Building2, User, Users } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ConnectorKind, ConnectorScope } from "@/lib/connectors-api";
import { cn } from "@/lib/utils";
import type { AgentOption } from "./connector-detail-sheet";

export const CONNECTOR_TYPES: Array<{ kind: ConnectorKind; label: string; hint: string; icon: typeof Building2 }> = [
  { kind: "org", label: "Organization", hint: "One shared sign-in; enable it for any agent", icon: Building2 },
  { kind: "agent", label: "Personal", hint: "One agent's own: only that agent can ever use it", icon: User },
  { kind: "identity", label: "Per identity", hint: "Defined once; each agent and person connects its own accounts", icon: Users },
];

export function ConnectorTypePicker({
  scope, agents, onChange, identityDisabled,
}: {
  scope: ConnectorScope;
  agents: AgentOption[];
  onChange: (scope: ConnectorScope) => void;
  /** Why per identity is not possible here (e.g. a local command); undefined: it is. */
  identityDisabled?: string;
}) {
  const owner = scope.kind === "agent" ? scope.agent : "";
  return (
    <fieldset className="space-y-1.5" data-testid="connector-type">
      <legend className="mb-1 text-xs font-medium">Type</legend>
      <div className="grid gap-1.5 sm:grid-cols-3">
        {CONNECTOR_TYPES.map((t) => {
          const disabled = (t.kind === "identity" && !!identityDisabled) || (t.kind === "agent" && agents.length === 0);
          const active = scope.kind === t.kind;
          return (
            <label
              key={t.kind}
              title={t.kind === "identity" && identityDisabled ? identityDisabled : undefined}
              className={cn(
                "cursor-pointer rounded-md border px-2.5 py-2 text-sm",
                active ? "border-primary bg-primary/5" : "hover:bg-muted/40",
                disabled && "cursor-not-allowed opacity-50",
              )}
            >
              <input
                type="radio" name="connector-type" className="sr-only" value={t.kind} checked={active} disabled={disabled}
                aria-label={t.label}
                onChange={() => onChange(t.kind === "org" ? { kind: "org" } : t.kind === "agent" ? { kind: "agent", agent: agents[0]?.name ?? "" } : { kind: "identity" })}
              />
              <span className="flex items-center gap-1.5 font-medium"><t.icon className="h-3.5 w-3.5 text-muted-foreground" /> {t.label}</span>
              <span className="block text-caption leading-tight text-muted-foreground">{t.hint}</span>
            </label>
          );
        })}
      </div>
      {scope.kind === "agent" && (
        <div className="flex items-center gap-2 pt-1">
          <span className="text-xs text-muted-foreground">Belongs to</span>
          <Select value={owner} onValueChange={(agent) => onChange({ kind: "agent", agent })}>
            <SelectTrigger size="sm" className="h-8 w-48 text-xs" aria-label="Agent it belongs to">
              <SelectValue placeholder="Pick an agent" />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {agents.map((a) => <SelectItem key={a.name} value={a.name} className="text-xs">{a.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
      {scope.kind === "identity" && (
        <p className="text-xs text-muted-foreground">
          Nobody signs in now: after adding it, each agent (and person) connects its own accounts, by name. Tools are called the same for everyone;
          each caller uses its default account, or another of its own with <code className="font-mono">account</code>.
        </p>
      )}
    </fieldset>
  );
}
