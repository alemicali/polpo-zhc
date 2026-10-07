import { KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";

export interface EnvFromVaultRef {
  name: string;
  ref: string;
}

/**
 * The vault references of a bash call's env_from_vault ({ VAR: "service.key" | { service, key } }).
 * Only references: the values never reach the browser.
 */
export function envFromVaultRefs(args: Record<string, unknown> | undefined): EnvFromVaultRef[] {
  const spec = args?.env_from_vault;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return [];
  const out: EnvFromVaultRef[] = [];
  for (const [name, value] of Object.entries(spec as Record<string, unknown>)) {
    if (typeof value === "string") out.push({ name, ref: value });
    else if (value && typeof value === "object") {
      const { service, key } = value as { service?: unknown; key?: unknown };
      if (typeof service === "string" && typeof key === "string") out.push({ name, ref: `${service}.${key}` });
    }
  }
  return out;
}

/** "GITHUB_TOKEN ← github.token" chips for a bash call that takes secrets from the vault. */
export function EnvFromVaultChips({ refs, className }: { refs: EnvFromVaultRef[]; className?: string }) {
  if (refs.length === 0) return null;
  const all = refs.map((r) => `${r.name} ← ${r.ref}`).join("\n");
  return (
    <span
      className={cn("flex min-w-0 items-center gap-1 overflow-hidden", className)}
      title={`Secrets from the vault, as environment variables of this command (masked as *** in its output):\n${all}`}
      data-testid="env-from-vault"
    >
      {refs.map((r) => (
        <span
          key={r.name}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/50 bg-muted/30 px-1.5 py-0 font-mono text-[10px] leading-4 text-muted-foreground"
        >
          <KeyRound className="h-2.5 w-2.5" />
          {r.name} ← {r.ref}
        </span>
      ))}
    </span>
  );
}
