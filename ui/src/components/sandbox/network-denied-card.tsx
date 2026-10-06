/**
 * "Refused recently": destinations the sandbox network rule refused, with one-click approval
 * (allow for one agent, or for everyone). Shown only when there is something.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  alreadyAllowed, allowEntryFor, approvalBlocker, planAllowForAgent, planAllowForEveryone, sandboxApi,
  type NetworkDeniedEntry, type SandboxOverview,
} from "@/lib/sandbox-api";

export function NetworkDeniedCard({ overview, onChanged }: { overview: SandboxOverview; onChanged: () => void }) {
  const [entries, setEntries] = useState<NetworkDeniedEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setEntries(await sandboxApi.networkDenied()); } catch { /* the list is a convenience */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const rows = entries.filter((e) => !alreadyAllowed(overview, e));
  if (!rows.length) return null;

  const run = async (key: string, action: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try { await action(); toast.success(done); onChanged(); await load(); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <section>
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
        <ShieldAlert className="h-3.5 w-3.5" /> Refused recently
      </h3>
      <p className="text-[11px] text-muted-foreground/80 mb-3 max-w-2xl">
        Destinations an agent tried to reach and the network rule refused. Allow a host to approve it; it applies to the next command.
      </p>
      <div className="rounded-lg border border-border/30 divide-y divide-border/20 overflow-hidden">
        {rows.map((e) => {
          const key = `${e.agentName}|${e.host}|${e.port}|${e.reason}`;
          const blocker = approvalBlocker(e);
          const forAgent = planAllowForAgent(overview, e);
          const forAll = planAllowForEveryone(overview, e);
          return (
            <div key={key} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
              <span className="font-mono">{e.host}{e.port ? `:${e.port}` : ""}</span>
              <Badge variant="outline" className="text-[9px]">{e.reason === "private-address" ? "private address" : "not allowed"}</Badge>
              <span className="text-muted-foreground">{e.agentName ?? "?"} · {e.count}x · {new Date(e.lastAt).toLocaleTimeString()}</span>
              <span className="flex-1" />
              {blocker ? <span className="text-[10px] text-muted-foreground max-w-xs leading-tight">{blocker}</span> : (
                <>
                  {forAgent && (
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy !== null}
                      onClick={() => void run(key, () => sandboxApi.saveAgent(forAgent.name, forAgent.settings), `${allowEntryFor(e)} allowed for ${forAgent.name}`)}>
                      {busy === key && <Loader2 className="h-3 w-3 animate-spin mr-1" />}Allow for {forAgent.name}
                    </Button>
                  )}
                  {forAll && (
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy !== null}
                      onClick={() => void run(key, async () => {
                        await sandboxApi.saveInstance(forAll.instance);
                        for (const a of forAll.agents) await sandboxApi.saveAgent(a.name, a.settings);
                      }, `${allowEntryFor(e)} allowed for everyone`)}>
                      Allow for everyone
                    </Button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
