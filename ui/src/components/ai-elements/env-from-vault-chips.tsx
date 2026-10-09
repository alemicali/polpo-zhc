import { KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EnvFromVaultRef } from "./env-from-vault";

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
