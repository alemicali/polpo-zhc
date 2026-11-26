/**
 * The engine picker of an agent (agent.engine): Polpo's own, an official harness enabled in
 * Settings → Harnesses (model, permission mode, effort, budget, its own key), or the official CLI
 * signed in with a person's account (account with its sign-in status, model, permission mode,
 * effort, budget). Controlled: the agent page's Engine card and the suite roles (a model + engine
 * block for the judge, the simulated user, the generator, the reviewer) both use it.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BrandIcon } from "@/components/shared/brand-icon";
import { VaultRefPicker } from "@/components/vault/vault-ref-picker";
import { CliAccountStatusBadge } from "@/components/config/cli-accounts-section";
import {
  CLI_NAMES, isCliEngine,
  type AgentCliEngine, type AgentHarnessEngine, type CliAccountView, type CliId, type CliOverview, type HarnessEffort, type HarnessesOverview, type HarnessId,
  type HarnessPermissionMode,
} from "@/lib/harnesses-api";

const selectClass = "h-8 rounded-md border bg-transparent px-2 text-xs";

export type EngineValue = AgentHarnessEngine | AgentCliEngine | "polpo";

export function EngineFields({
  value, onChange, overview, cliData, computer = "host", saved, onSignIn,
}: {
  value: EngineValue;
  onChange: (engine: EngineValue) => void;
  overview: HarnessesOverview;
  cliData: CliOverview | null;
  /** The computer the engine runs on (the CLI accounts there are offered first). */
  computer?: string;
  /** The engine saved now: its harness or CLI stays offered even when it is no longer enabled. */
  saved?: EngineValue;
  /** Opens the sign-in terminal of a CLI account. */
  onSignIn?: (account: CliAccountView) => void;
}) {
  const savedCli = saved !== undefined && isCliEngine(saved) ? saved : undefined;
  const savedHarness = saved !== undefined && saved !== "polpo" && !isCliEngine(saved) ? saved : undefined;
  const enabled = (overview.harnesses ?? []).filter((h) => h.enabled || h.id === savedHarness?.harness);
  const cliAccounts = cliData?.accounts ?? [];
  // the CLIs with an account (or the one saved)
  const clis = (["claude", "codex"] as CliId[]).filter((c) => cliAccounts.some((a) => a.cli === c) || savedCli?.cli === c);
  const harness = value === "polpo" || isCliEngine(value) ? undefined : value;
  const cli = isCliEngine(value) ? value : undefined;
  const set = (patch: Partial<AgentHarnessEngine>) => harness && onChange({ ...harness, ...patch });
  const setCli = (patch: Partial<AgentCliEngine>) => cli && onChange({ ...cli, ...patch });
  // the accounts usable here: that CLI's, on this computer
  const usable = cli ? cliAccounts.filter((a) => a.cli === cli.cli && a.computer === computer) : [];
  const chosen = cli ? (cli.account ? cliAccounts.find((a) => a.id === cli.account) : usable.length === 1 ? usable[0] : undefined) : undefined;

  return (
    <>
      <select
        aria-label="Engine" className={selectClass}
        value={cli ? `cli:${cli.cli}` : harness?.harness ?? "polpo"}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "polpo") onChange("polpo");
          else if (v.startsWith("cli:")) onChange({ type: "cli", cli: v.slice(4) as CliId });
          else onChange({ harness: v as HarnessId, permissionMode: "allow-all" });
        }}
      >
        <option value="polpo">Polpo</option>
        {enabled.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
        {clis.map((c) => <option key={c} value={`cli:${c}`}>{CLI_NAMES[c]}</option>)}
      </select>
      {cli && (
        <>
          <BrandIcon name={cli.cli === "claude" ? "claude-code" : "codex"} size={16} />
          <select aria-label="CLI account" className={selectClass} value={cli.account ?? ""} onChange={(e) => setCli({ account: e.target.value || undefined })}>
            <option value="">{usable.length === 1 ? `Account: ${usable[0]!.label || usable[0]!.id}` : "Choose an account"}</option>
            {cliAccounts.filter((a) => a.cli === cli.cli).map((a) => (
              <option key={a.id} value={a.id}>{a.label || a.id} · {a.owner}{a.computer !== computer ? ` (on ${a.computer})` : ""}</option>
            ))}
          </select>
          {chosen && <CliAccountStatusBadge account={chosen} />}
          {chosen?.manageable && !chosen.report?.status?.signedIn && onSignIn && (
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onSignIn(chosen)} data-testid="agent-cli-signin">Sign in</Button>
          )}
          <Input className="h-8 w-44 text-xs" placeholder="Model (default: the CLI's)" value={cli.model ?? ""}
            onChange={(e) => setCli({ model: e.target.value.trim() || undefined })} aria-label="CLI model" />
          <select aria-label="CLI permission mode" className={selectClass} value={cli.permissionMode ?? "allow-all"} onChange={(e) => setCli({ permissionMode: e.target.value as HarnessPermissionMode })}>
            <option value="allow-all">Works unattended (allow all)</option>
            <option value="allow-edits">Edits only</option>
            <option value="allow-reads">Read only</option>
          </select>
          <select aria-label="CLI effort" className={selectClass} value={cli.effort ?? ""} onChange={(e) => setCli({ effort: (e.target.value || undefined) as HarnessEffort | undefined })}>
            <option value="">Default effort</option>
            {(["low", "medium", "high", "xhigh", "max"] as const).map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          {cli.cli === "claude" && (
            <Input className="h-8 w-32 text-xs" type="number" min={0} step={0.5} placeholder="Budget $/run" value={cli.maxBudgetUsd ?? ""}
              onChange={(e) => setCli({ maxBudgetUsd: e.target.value ? Number(e.target.value) : undefined })} aria-label="CLI budget per run (USD)" />
          )}
        </>
      )}
      {harness && <BrandIcon name={harness.harness} size={16} />}
      {harness && (
        <>
          <Input className="h-8 w-56 text-xs" placeholder={`Model (default: ${overview.harnesses.find((h) => h.id === harness.harness)?.model ?? (harness.harness === "opencode" ? "the setting's" : "the runtime's")})`}
            value={harness.model ?? ""} onChange={(e) => set({ model: e.target.value.trim() || undefined })} aria-label="Harness model" />
          <select aria-label="Permission mode" className={selectClass} value={harness.permissionMode ?? "allow-all"} onChange={(e) => set({ permissionMode: e.target.value as HarnessPermissionMode })}>
            <option value="allow-all">Works unattended (allow all)</option>
            <option value="allow-edits">Edits only</option>
            <option value="allow-reads">Read only</option>
          </select>
          <select aria-label="Effort" className={selectClass} value={harness.effort ?? ""} onChange={(e) => set({ effort: (e.target.value || undefined) as HarnessEffort | undefined })}>
            <option value="">Default effort</option>
            {(["low", "medium", "high", "xhigh", "max"] as const).map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          {harness.harness === "claude-code" || harness.maxBudgetUsd ? (
            <Input className="h-8 w-32 text-xs" type="number" min={0} step={0.5} placeholder="Budget $/run" value={harness.maxBudgetUsd ?? ""}
              onChange={(e) => set({ maxBudgetUsd: e.target.value ? Number(e.target.value) : undefined })} aria-label="Budget per run (USD)" />
          ) : null}
          {(() => {
            const s = overview.harnesses.find((h) => h.id === harness.harness);
            // its own key replaces an API key or a gateway key (not Bedrock / Vertex, not a keyless gateway;
            // OpenCode's Bedrock API key is a key too)
            const can = s?.auth && (s.auth !== "bedrock" || harness.harness === "opencode") && s.auth !== "vertex" && s.gateway?.authScheme !== "none";
            return can || harness.credentialRef ? (
              <div className="w-64" title="This agent's own key (cost separation): replaces the harness's key for its runs">
                <VaultRefPicker value={harness.credentialRef} onChange={(ref) => set({ credentialRef: ref ?? undefined })} requiredKeys={["apiKey"]}
                  placeholder="Own key (optional): the harness's" aria-label="Agent's own harness key" />
              </div>
            ) : null;
          })()}
        </>
      )}
    </>
  );
}
