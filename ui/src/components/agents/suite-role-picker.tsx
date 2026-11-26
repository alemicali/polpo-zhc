/**
 * Who plays one of a suite's LLM roles (the judge, the simulated user, the case generator, the run
 * reviewer): Polpo (the default), an existing agent (its name and optionally a version or the
 * draft), or a model + engine block exactly as an agent's — the shared model field with the engine
 * badge and the agent page's engine picker (Polpo's engine, a harness, the official CLI with a
 * person's account). The server runs the role as a chat turn through the chat pipeline, without tools.
 */
import { useEffect, useState } from "react";
import { useAgents, type SuiteRole } from "@polpo-ai/react";
import { Input } from "@/components/ui/input";
import { ModelField } from "@/components/shared/model-field";
import { agentEngineInfo } from "@/lib/engine-mark";
import { harnessesApi, type CliOverview, type HarnessesOverview } from "@/lib/harnesses-api";
import { EngineFields, type EngineValue } from "./engine-fields";
import { roleKind, type SuiteRoleKind } from "@/lib/suite-roles";

type Kind = SuiteRoleKind;

const selectClass = "h-8 rounded-md border bg-transparent px-2 text-xs";
const REASONING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function SuiteRolePicker({ label, value, onChange, inheritLabel = "Polpo (default)", testId }: {
  label: string;
  value: SuiteRole | undefined;
  onChange: (role: SuiteRole | undefined) => void;
  /** What "nothing set" means here: Polpo, or the suite's role. */
  inheritLabel?: string;
  testId?: string;
}) {
  // the kind chosen before anything is filled in (an empty block is still Polpo)
  const [picked, setPicked] = useState<Kind | null>(null);
  const kind = roleKind(value) !== "polpo" ? roleKind(value) : picked ?? "polpo";
  const { agents } = useAgents();
  const [overview, setOverview] = useState<HarnessesOverview | null>(null);
  const [cliData, setCliData] = useState<CliOverview | null>(null);
  useEffect(() => {
    if (kind !== "block" || overview) return;
    void harnessesApi.overview().then(setOverview).catch(() => setOverview(null));
    void harnessesApi.cliAccounts().then(setCliData).catch(() => setCliData(null));
  }, [kind, overview]);

  const at = value?.agent ? value.agent.lastIndexOf("@") : -1;
  const agentName = value?.agent ? (at > 0 ? value.agent.slice(0, at) : value.agent) : "";
  const agentRef = value?.agent && at > 0 ? value.agent.slice(at + 1) : "";
  const setAgent = (name: string, ref: string) => onChange({ agent: ref.trim() ? `${name}@${ref.trim()}` : name });
  const block: SuiteRole = kind === "block" ? value ?? {} : {};
  const setBlock = (patch: Partial<SuiteRole>) => {
    const next = { ...block, ...patch } as SuiteRole;
    for (const k of Object.keys(next) as Array<keyof SuiteRole>) if (next[k] === undefined) delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  const engine = (block.engine as EngineValue | undefined) ?? "polpo";

  return (
    <div className="block min-w-0 space-y-1.5" data-testid={testId} data-role-kind={kind}>
      <span className="text-micro text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        {/* native selects, as the agent page's engine picker */}
        <select aria-label={`${label}: who plays it`} className={selectClass} value={kind} data-testid={testId ? `${testId}-kind` : undefined}
          onChange={(e) => {
            const v = e.target.value as Kind;
            setPicked(v);
            onChange(v === "agent" && agents[0] ? { agent: agents[0].name } : undefined);
          }}>
          <option value="polpo">{inheritLabel}</option>
          <option value="agent">An agent</option>
          <option value="block">Model and engine</option>
        </select>
        {kind === "agent" && (
          <>
            <select aria-label={`${label}: agent`} className={selectClass} value={agentName} onChange={(e) => e.target.value && setAgent(e.target.value, agentRef)}>
              {!agentName && <option value="">Choose an agent</option>}
              {agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
            </select>
            <Input className="h-8 w-36 text-caption" value={agentRef} placeholder="production" aria-label={`${label}: version`}
              onChange={(e) => agentName && setAgent(agentName, e.target.value)} />
          </>
        )}
      </div>
      {kind === "block" && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <ModelField className="min-w-0 flex-1 basis-64" value={block.model} onChange={(model) => setBlock({ model })}
              engine={agentEngineInfo({ model: block.model, engine: block.engine }).engine} fallback="The engine's default model" ariaLabel={`${label}: model`} />
            <select aria-label={`${label}: reasoning`} className={selectClass} value={block.reasoning ?? ""}
              onChange={(e) => setBlock({ reasoning: e.target.value || undefined })}>
              <option value="">Default reasoning</option>
              {REASONING.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          {overview && (
            <div className="flex flex-wrap items-center gap-2">
              <EngineFields value={engine} onChange={(e) => setBlock({ engine: e === "polpo" ? undefined : e as unknown as Record<string, unknown> })} overview={overview} cliData={cliData} saved={engine} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
