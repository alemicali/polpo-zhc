// Setup wizard: connect a local (offline) model server — Ollama, LM Studio, vLLM or any
// OpenAI-compatible server on this machine or the local network. The server's models are
// discovered through POST /config/local-provider/discover; the chosen server is saved as
// a custom provider when setup completes.

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronLeft, Cpu, Loader2, RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ApiFetch } from "@/components/shared/provider-auth";

export interface LocalModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  /** Ollama only: whether the model supports tool calling (needed to run tasks). */
  tools?: boolean;
}

/** What the wizard sends to /config/initialize as `localProvider`. */
export interface LocalProviderChoice {
  /** Provider id in polpo.json, the model-spec prefix ("<id>:<model>"). */
  id: string;
  preset: string;
  label: string;
  baseUrl: string;
  models: LocalModel[];
}

const SERVERS = [
  { preset: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1", hint: "Start it with the Ollama app or `ollama serve`." },
  { preset: "lm-studio", label: "LM Studio", baseUrl: "http://localhost:1234/v1", hint: "In LM Studio, open Developer → Start Server." },
  { preset: "vllm", label: "vLLM", baseUrl: "http://localhost:8000/v1", hint: "Start it with `vllm serve <model>`." },
  { preset: "openai-compatible", label: "Other", baseUrl: "http://localhost:8080/v1", hint: "Any OpenAI-compatible server (llama.cpp, LocalAI, Jan…)." },
] as const;

interface Discovery {
  id: string;
  baseUrl: string;
  models: LocalModel[];
  warnings: string[];
}

export function LocalModelStep({
  apiFetch,
  value,
  onChange,
  onBack,
}: {
  apiFetch: ApiFetch;
  value: LocalProviderChoice | null;
  onChange: (choice: LocalProviderChoice | null) => void;
  onBack: () => void;
}) {
  const [preset, setPreset] = useState<string>(value?.preset ?? "ollama");
  const server = SERVERS.find((s) => s.preset === preset) ?? SERVERS[0];
  const [baseUrl, setBaseUrl] = useState(value?.baseUrl ?? server.baseUrl);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualModel, setManualModel] = useState("");

  const discover = async (p = preset, url = baseUrl) => {
    setDiscovering(true);
    setError(null);
    setDiscovery(null);
    onChange(null);
    const r = await apiFetch("/config/local-provider/discover", {
      method: "POST",
      body: JSON.stringify({ preset: p, baseUrl: url }),
    });
    setDiscovering(false);
    if (!r.ok) {
      setError(r.error ?? "Could not reach the server");
      return;
    }
    const d = r.data as Discovery;
    setDiscovery(d);
    if (d.models.length > 0) {
      onChange({ id: d.id, preset: p, label: SERVERS.find((s) => s.preset === p)!.label, baseUrl: d.baseUrl, models: d.models });
    }
  };

  // Try the default address of the selected server right away.
  useEffect(() => {
    if (!value) void discover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickServer = (p: string) => {
    const s = SERVERS.find((x) => x.preset === p)!;
    setPreset(p);
    setBaseUrl(s.baseUrl);
    void discover(p, s.baseUrl);
  };

  const useManualModel = () => {
    if (!discovery || !manualModel.trim()) return;
    onChange({ id: discovery.id, preset, label: server.label, baseUrl: discovery.baseUrl, models: [{ id: manualModel.trim() }] });
  };

  const models = value?.models ?? discovery?.models ?? [];
  const connected = !!value;

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2">
        <Button type="button" variant="ghost" size="sm" className="-ml-2 h-8 px-2" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Local model (offline)</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Use a model running on this computer or your network. Nothing leaves your machine and no API key is needed.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        {SERVERS.map((s) => (
          <button
            key={s.preset}
            type="button"
            onClick={() => pickServer(s.preset)}
            className={cn(
              "rounded-md border px-2 py-2 text-xs font-medium transition-colors",
              preset === s.preset ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-accent/50",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Server address</label>
        <div className="flex gap-2">
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void discover(); }}
            className="font-mono text-xs"
          />
          <Button type="button" variant="outline" size="sm" className="h-9 gap-1.5" disabled={discovering} onClick={() => void discover()}>
            {discovering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Detect
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">{server.hint}</p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {discovery && discovery.models.length === 0 && !connected && (
        <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            The server did not list any model.
          </p>
          {discovery.warnings.length > 0 && <p className="text-muted-foreground">{discovery.warnings.join(" · ")}</p>}
          <p className="text-muted-foreground">Is it running with a model loaded? You can also type a model id:</p>
          <div className="flex gap-2">
            <Input value={manualModel} onChange={(e) => setManualModel(e.target.value)} placeholder="e.g. llama3.1:8b" className="h-8 font-mono text-xs" />
            <Button type="button" size="sm" className="h-8" disabled={!manualModel.trim()} onClick={useManualModel}>Use</Button>
          </div>
        </div>
      )}

      {connected && (
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" />
            {value.label} connected — {models.length} model{models.length !== 1 ? "s" : ""} available
          </p>
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border/60 p-2">
            {models.map((m) => (
              <div key={m.id} className="flex items-center gap-2 text-xs">
                <Cpu className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono">{m.id}</span>
                {m.tools === false && <NoToolsBadge />}
                {m.contextWindow && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{Math.round(m.contextWindow / 1000)}k ctx</span>}
              </div>
            ))}
          </div>
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Server className="h-3 w-3" /> You choose which model to use in the next step.
          </p>
          <ContextHint preset={preset} />
        </div>
      )}
    </div>
  );
}

/** Marks a model that cannot call tools, so cannot act in tasks (write files, run commands). */
export function NoToolsBadge() {
  return (
    <span
      className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[9px] font-medium text-amber-600 dark:text-amber-400"
      title="This model does not support tool calling: it can chat, but agents using it cannot write files or run commands, so their tasks fail."
    >
      no tools
    </span>
  );
}

/**
 * Agent tasks fit in a 16k context, but a chat with the orchestrator sends about 65k tokens
 * (instructions and tool definitions): local servers default to much less and refuse it.
 */
function ContextHint({ preset }: { preset: string }) {
  const how: Record<string, React.ReactNode> = {
    ollama: <>In Ollama open <b>Settings → Context length</b> and choose 64k or more (or start it with <code>OLLAMA_CONTEXT_LENGTH=65536</code>).</>,
    "lm-studio": <>In LM Studio, load the model with a <b>context length</b> of 64k or more.</>,
    vllm: <>Start vLLM with <code>--max-model-len 65536</code> or more.</>,
    "openai-compatible": <>Start the server with a context size of 64k tokens or more (for llama.cpp: <code>-c 65536</code>).</>,
  };
  return (
    <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[11px] leading-relaxed">
      <p className="flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5" />
        Give the model enough context
      </p>
      <p className="text-muted-foreground">
        Agents&apos; tasks work with a 16k context, but chatting with the orchestrator needs about 64k tokens.
        Local servers often default to less. {how[preset] ?? how["openai-compatible"]}
        {" "}A larger context uses more memory.
      </p>
    </div>
  );
}
