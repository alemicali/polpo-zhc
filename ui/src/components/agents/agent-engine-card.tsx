/**
 * The agent's engine: Polpo's own, or an official harness (Claude Code, Codex, OpenCode) running in its
 * computer. Only harnesses enabled in Settings → Harnesses are offered; the server refuses an
 * engine the agent's computer cannot run (shown as the error). Model, permission mode, effort, a
 * per-run budget and the agent's own key (a vault reference that replaces the harness's API key or
 * gateway key, for cost separation) are the harness options. `PATCH /agents/:name { engine }`;
 * after a save the connection is tested with the agent's settings.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Cpu, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BrandIcon } from "@/components/shared/brand-icon";
import { VaultRefPicker } from "@/components/vault/vault-ref-picker";
import { HarnessTestLine } from "@/components/config/harness-test-line";
import { ProviderIcon } from "@/components/shared/provider-icon";
import { authBrand, AUTH_LABELS, engineBrand, engineLabel, openCodeProviderIcon } from "@/lib/run-context";
import {
  HARNESS_NAMES, harnessesApi,
  type AgentHarnessEngine, type HarnessEffort, type HarnessesOverview, type HarnessId, type HarnessPermissionMode, type HarnessSession, type HarnessTestResult,
} from "@/lib/harnesses-api";
import { useAgentDetail } from "./agent-detail-context";

const selectClass = "h-8 rounded-md border bg-transparent px-2 text-xs";

export function AgentEngineCard() {
  const { state: { agent }, actions: { refetch }, meta: { agentName } } = useAgentDetail();
  const current = (agent as { engine?: AgentHarnessEngine }).engine;
  const [overview, setOverview] = useState<HarnessesOverview | null>(null);
  const [sessions, setSessions] = useState<HarnessSession[]>([]);
  const [draft, setDraft] = useState<AgentHarnessEngine | "polpo">(current ?? "polpo");
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<HarnessTestResult | "running" | undefined>();

  useEffect(() => { setDraft(current ?? "polpo"); }, [current]);
  useEffect(() => {
    void harnessesApi.overview().then(setOverview).catch(() => setOverview(null));
    void harnessesApi.sessions({ agent: agentName }).then(setSessions).catch(() => setSessions([]));
  }, [agentName]);

  const enabled = (overview?.harnesses ?? []).filter((h) => h.enabled || h.id === current?.harness);
  // nothing to choose and nothing set: the card stays out of the way
  if (!overview || (enabled.length === 0 && !current)) return null;

  const harness = draft === "polpo" ? undefined : draft;
  const set = (patch: Partial<AgentHarnessEngine>) => harness && setDraft({ ...harness, ...patch });
  const changed = JSON.stringify(draft) !== JSON.stringify(current ?? "polpo");

  const save = async () => {
    setSaving(true);
    try {
      await harnessesApi.setEngine(agentName, draft);
      await refetch();
      toast.success(draft === "polpo" ? "Runs on Polpo's engine" : `Runs on ${HARNESS_NAMES[draft.harness]}`);
      // check it right away: one tiny model request from the Polpo server, with this agent's key and model
      if (draft !== "polpo") {
        setTest("running");
        harnessesApi.test(draft.harness, { agent: agentName }).then(setTest, (e: Error) => setTest({ ok: false, harness: draft.harness, latencyMs: 0, errorKind: "config", error: e.message }));
      } else {
        setTest(undefined);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="gap-0 border-border/40 bg-card/80 py-0 backdrop-blur-surface" data-testid="agent-engine-card">
      <CardContent className="space-y-3 px-4 py-3 text-xs">
        <div className="flex items-center gap-1.5 text-label text-muted-foreground"><Cpu className="h-3 w-3" /> Engine</div>
        {/* the engine it runs on now, with its mark (and how the harness authenticates) */}
        <div className="flex items-center gap-2 text-small" data-testid="agent-engine-current">
          <BrandIcon name={engineBrand(current?.harness)} size={20} />
          <span className="font-medium">{engineLabel(current?.harness)}</span>
          {current?.model && <span className="text-muted-foreground">{current.model}</span>}
          {(() => {
            const item = current ? overview.harnesses.find((h) => h.id === current.harness) : undefined;
            const auth = item?.auth;
            const ocProvider = openCodeProviderIcon(current?.harness, { kind: auth, provider: item?.provider });
            return auth ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground" title={`Authenticates with ${AUTH_LABELS[auth] ?? auth}${item?.provider ? ` (${item.provider})` : ""}`}>
                {ocProvider ? <ProviderIcon name={ocProvider} size={14} /> : <BrandIcon name={authBrand(auth, current?.harness, item?.provider)} size={14} />}
                {AUTH_LABELS[auth] ?? auth}{item?.provider && auth === "api-key" ? ` · ${item.provider}` : ""}
              </span>
            ) : null;
          })()}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Engine" className={selectClass}
            value={harness?.harness ?? "polpo"}
            onChange={(e) => setDraft(e.target.value === "polpo" ? "polpo" : { harness: e.target.value as HarnessId, permissionMode: "allow-all" })}
          >
            <option value="polpo">Polpo</option>
            {enabled.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
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
          <Button size="sm" className="h-8 text-xs" disabled={!changed || saving} onClick={() => void save()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save engine
          </Button>
        </div>
        <p className="text-muted-foreground">
          {harness
            ? `${HARNESS_NAMES[harness.harness]} runs inside this agent's computer (a Daytona v2 computer), with Polpo's tools available to it. Its usage is billed to the credential in `
            : "Polpo's own engine, with any model of the instance. Harnesses are set up in "}
          <Link to="/config?section=harnesses" className="underline">Settings → Harnesses</Link>.
        </p>
        <HarnessTestLine result={test} />
        {sessions.length > 0 && (
          <p className="text-muted-foreground" data-testid="agent-harness-sessions">
            {sessions.length} harness session(s) · ${sessions.reduce((t, s) => t + s.costUsd, 0).toFixed(4)} so far
            {sessions.some((s) => s.live) ? " · one is running now" : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
