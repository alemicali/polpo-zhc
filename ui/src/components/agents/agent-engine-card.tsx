/**
 * The agent's engine: Polpo's own, or an official harness (Claude Code, Codex, OpenCode) running in its
 * computer. Only harnesses enabled in Settings → Harnesses are offered; the server refuses an
 * engine the agent's computer cannot run (shown as the error). Model, permission mode, effort, a
 * per-run budget and the agent's own key (a vault reference that replaces the harness's API key or
 * gateway key, for cost separation) are the harness options. `PATCH /agents/:name { engine }`;
 * after a save the connection is tested with the agent's settings.
 *
 * The CLI engine ("Claude Code (CLI)", "Codex (CLI)"): the official program signed in with a
 * person's own plan (a CLI account on the agent's computer, with its sign-in status and a Sign in
 * button that opens the account's sign-in terminal), a model and a permission mode.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Cpu, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BrandIcon } from "@/components/shared/brand-icon";
import { HarnessTestLine } from "@/components/config/harness-test-line";
import { ProviderIcon } from "@/components/shared/provider-icon";
import { authBrand, AUTH_LABELS, openCodeProviderIcon } from "@/lib/run-context";
import { agentEngineInfo, engineInfo } from "@/lib/engine-mark";
import { ModelWithEngine } from "@/components/shared/model-with-engine";
import {
  CLI_NAMES, HARNESS_NAMES, harnessesApi, isCliEngine,
  type AgentCliEngine, type AgentHarnessEngine, type CliAccountView, type CliId, type CliOverview, type HarnessesOverview,
  type HarnessSession, type HarnessTestResult,
} from "@/lib/harnesses-api";
import { CliSignInDialog } from "@/components/config/cli-accounts-section";
import { EngineFields } from "./engine-fields";
import { useAgentDetail } from "./agent-detail-context";

export function AgentEngineCard() {
  const { state: { agent }, actions: { refetch }, meta: { agentName } } = useAgentDetail();
  const engine = (agent as { engine?: AgentHarnessEngine | AgentCliEngine }).engine;
  const currentCli = isCliEngine(engine) ? engine : undefined;
  const current = isCliEngine(engine) ? undefined : engine;
  const computer = (agent as { defaultComputer?: string }).defaultComputer || "host";
  const [overview, setOverview] = useState<HarnessesOverview | null>(null);
  const [cliData, setCliData] = useState<CliOverview | null>(null);
  const [signIn, setSignIn] = useState<CliAccountView | null>(null);
  const [sessions, setSessions] = useState<HarnessSession[]>([]);
  const [draft, setDraft] = useState<AgentHarnessEngine | AgentCliEngine | "polpo">(engine ?? "polpo");
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<HarnessTestResult | "running" | undefined>();

  useEffect(() => { setDraft(engine ?? "polpo"); }, [engine]);
  useEffect(() => {
    void harnessesApi.overview().then(setOverview).catch(() => setOverview(null));
    void harnessesApi.cliAccounts().then(setCliData).catch(() => setCliData(null));
    void harnessesApi.sessions({ agent: agentName }).then(setSessions).catch(() => setSessions([]));
  }, [agentName]);

  const enabled = (overview?.harnesses ?? []).filter((h) => h.enabled || h.id === current?.harness);
  const cliAccounts = cliData?.accounts ?? [];
  // the CLIs with an account (or the one this agent uses)
  const clis = (["claude", "codex"] as CliId[]).filter((c) => cliAccounts.some((a) => a.cli === c) || currentCli?.cli === c);
  // nothing to choose and nothing set: the card stays out of the way
  if (!overview || (enabled.length === 0 && clis.length === 0 && !engine)) return null;

  const harness = draft === "polpo" || isCliEngine(draft) ? undefined : draft;
  const cli = isCliEngine(draft) ? draft : undefined;
  const changed = JSON.stringify(draft) !== JSON.stringify(engine ?? "polpo");

  const save = async () => {
    setSaving(true);
    try {
      await harnessesApi.setEngine(agentName, draft);
      await refetch();
      toast.success(draft === "polpo" ? "Runs on Polpo's engine" : isCliEngine(draft) ? `Runs on ${CLI_NAMES[draft.cli]}` : `Runs on ${HARNESS_NAMES[draft.harness]}`);
      // check it right away: one tiny model request from the Polpo server, with this agent's key and model
      if (draft !== "polpo" && !isCliEngine(draft)) {
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
          {(() => {
            // the model it runs, then the engine (with how it authenticates in the tooltip)
            const { engine: info, model } = agentEngineInfo(agent as { model?: unknown; engine?: unknown });
            const item = current ? overview.harnesses.find((h) => h.id === current.harness) : undefined;
            const withAuth = item?.auth ? engineInfo(info.id, { kind: item.auth, ...(item.provider ? { provider: item.provider } : {}) }) : info;
            return <ModelWithEngine model={model} engine={withAuth} fallback={info.kind === "polpo" ? undefined : "default model"} mono size={18} className="font-medium" testId="agent-engine-model" />;
          })()}
          {currentCli && <span className="text-muted-foreground">personal plan{currentCli.account ? ` · ${currentCli.account}` : ""}</span>}
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
          <EngineFields value={draft} onChange={setDraft} overview={overview} cliData={cliData} computer={computer} saved={engine ?? "polpo"} onSignIn={setSignIn} />
          <Button size="sm" className="h-8 text-xs" disabled={!changed || saving} onClick={() => void save()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save engine
          </Button>
        </div>
        {cli && (
          <p className="text-muted-foreground" data-testid="agent-cli-note">
            {CLI_NAMES[cli.cli]} runs the official program on {computer === "host" ? "this server" : computer}, signed in with a person's own plan.
            It runs only the work of its account's owner (their tasks, missions, schedules and chats: Anthropic's and OpenAI's terms), with Polpo's tools; its tokens are counted, not billed by Polpo.
          </p>
        )}
        <CliSignInDialog account={signIn} onClose={() => { setSignIn(null); void harnessesApi.cliAccounts().then(setCliData).catch(() => undefined); }} />
        <p className="text-muted-foreground">
          {harness
            ? `${HARNESS_NAMES[harness.harness]} runs inside this agent's computer (a Daytona v2 computer), with Polpo's tools available to it. Its usage is billed to the credential in `
            : cli ? "CLI accounts are added and signed in under "
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
