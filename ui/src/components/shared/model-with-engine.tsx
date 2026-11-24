/**
 * A model, always followed by the engine that runs it: `claude-sonnet-4-6 · [mark] Claude Code CLI`,
 * `kimi-k3.1 · [mark] OpenCode Harness`, `gpt-6 · [mark] Polpo`. One component for every place a
 * model is shown (agents, chat, tasks and runs, computers, settings, search).
 *
 * - EngineMark: the engine's mark and its type label ("Polpo", "Claude Code Harness", "Codex CLI");
 *   compact: the mark only (lists, chips), with the label in the tooltip.
 * - ModelWithEngine: model · EngineMark.
 * - AgentModelWithEngine / RunModelWithEngine: resolved from an agent's config or a run's record.
 *
 * The tooltip (title) has the model, the engine, its runtime and how it authenticates (never a secret).
 */
import { BrandIcon } from "@/components/shared/brand-icon";
import {
  agentEngineInfo, engineInfo, engineTooltip, runEngineInfo,
  type EngineAuthInfo, type EngineInfo,
} from "@/lib/engine-mark";
import { modelLabel } from "@/lib/run-context";
import { cn } from "@/lib/utils";

type EngineInput = EngineInfo | string | undefined;

const resolve = (engine: EngineInput, auth?: EngineAuthInfo): EngineInfo =>
  engine && typeof engine === "object" ? engine : engineInfo(engine, auth);

export function EngineMark({
  engine, auth, model, compact = false, size = 14, className,
}: {
  /** An engine id ("polpo", "claude-code", "codex-cli"…) or a resolved EngineInfo. */
  engine: EngineInput;
  auth?: EngineAuthInfo;
  /** For the tooltip. */
  model?: string;
  /** The mark only (the label goes to the tooltip). */
  compact?: boolean;
  size?: number;
  className?: string;
}) {
  const info = resolve(engine, auth);
  const tip = engineTooltip(info, model);
  return (
    <span
      className={cn("inline-flex min-w-0 shrink-0 items-center gap-1 align-middle", className)}
      title={tip}
      aria-label={compact ? info.label : undefined}
      data-testid="engine-mark"
      data-engine={info.id}
      data-engine-kind={info.kind}
    >
      <BrandIcon name={info.brand} size={size} title={info.label} />
      {!compact && <span className="truncate">{info.label}</span>}
    </span>
  );
}

export function ModelWithEngine({
  model, engine, auth, compact = false, pretty = false, mono = false, size = 14, fallback, className, modelClassName, testId,
}: {
  model: string | undefined;
  engine: EngineInput;
  auth?: EngineAuthInfo;
  compact?: boolean;
  /** "Sonnet 4.5" instead of the raw id (the raw id stays in the tooltip). */
  pretty?: boolean;
  mono?: boolean;
  size?: number;
  /** Shown when there is no model (e.g. "default"); nothing by default. */
  fallback?: string;
  className?: string;
  modelClassName?: string;
  testId?: string;
}) {
  const info = resolve(engine, auth);
  const shown = model ? (pretty ? modelLabel(model) ?? model : model) : fallback;
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1", className)} data-testid={testId ?? "model-with-engine"} data-engine={info.id}>
      {shown && <span className={cn("min-w-0 truncate", mono && "font-mono", modelClassName)} title={model} data-testid="model-name">{shown}</span>}
      {shown && <span aria-hidden className="shrink-0 text-muted-foreground/70">·</span>}
      <EngineMark engine={info} model={model} compact={compact} size={size} />
    </span>
  );
}

/** An agent's model and engine, from its config (engine absent → Polpo; a harness or CLI's own model). */
export function AgentModelWithEngine({ agent, ...rest }: { agent: { model?: unknown; engine?: unknown } | undefined } & Omit<Parameters<typeof ModelWithEngine>[0], "model" | "engine" | "auth">) {
  const { engine, model } = agentEngineInfo(agent);
  return <ModelWithEngine model={model} engine={engine} {...rest} />;
}

/** A run's model and engine, as the run recorded them (what actually ran). */
export function RunModelWithEngine({ run, ...rest }: { run: Parameters<typeof runEngineInfo>[0] } & Omit<Parameters<typeof ModelWithEngine>[0], "model" | "engine" | "auth">) {
  const { engine, model } = runEngineInfo(run);
  return <ModelWithEngine model={model} engine={engine} {...rest} />;
}
