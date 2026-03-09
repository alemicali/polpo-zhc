import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { config } from "@/lib/config";
import {
  KeyRound,
  Sparkles,
  Cpu,
  FolderOpen,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  Eye,
  EyeOff,
  Loader2,
  Zap,
  ArrowRight,
  ExternalLink,
  LogIn,
  Keyboard,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──

interface Provider {
  name: string;
  envVar: string;
  hasKey: boolean;
}

interface OAuthProvider {
  id: string;
  name: string;
  flow: string;
  free: boolean;
}

interface Model {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  cost: { input: number; output: number };
}

interface SetupStatus {
  needsSetup: boolean;
  hasConfig: boolean;
  hasProviders: boolean;
  detectedProviders: Provider[];
  workDir: string;
  orgName: string;
}

// ── API helpers ──

const api = (path: string, init?: RequestInit) =>
  fetch(`${config.baseUrl}/api/v1${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  }).then((r) => r.json());

// ── Step components ──

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={cn(
            "h-1.5 rounded-full transition-all duration-500",
            i < current ? "bg-primary w-8" : i === current ? "bg-primary/60 w-6" : "bg-muted w-4",
          )}
        />
      ))}
    </div>
  );
}

// Step 0: Project directory + org name
function ProjectStep({
  workDir,
  orgName,
  onChangeDir,
  onChangeOrg,
}: {
  workDir: string;
  orgName: string;
  onChangeDir: (v: string) => void;
  onChangeOrg: (v: string) => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Your project</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Where should Polpo store its configuration and data?
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Working directory
          </label>
          <Input
            value={workDir}
            onChange={(e) => onChangeDir(e.target.value)}
            placeholder="/path/to/your/project"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Config will be saved to <code className="bg-muted px-1 py-0.5 rounded">{workDir}/.polpo/polpo.json</code>
          </p>
        </div>
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Organization name
          </label>
          <Input
            value={orgName}
            onChange={(e) => onChangeOrg(e.target.value)}
            placeholder="my-project"
          />
          <p className="text-xs text-muted-foreground">
            A label for your project — shown in the dashboard header
          </p>
        </div>
      </div>
    </div>
  );
}

// Step 1: Auth — OAuth or API key
function AuthStep({
  providers,
  onKeySave,
  onOAuthComplete,
  onOAuthActiveChange,
}: {
  providers: Provider[];
  onKeySave: (provider: string, key: string) => Promise<void>;
  onOAuthComplete: () => void;
  onOAuthActiveChange?: (active: boolean) => void;
}) {
  type AuthMode = "choose" | "oauth" | "apikey";
  const [mode, setMode] = useState<AuthMode>("choose");
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [connectedProviders, setConnectedProviders] = useState<string[]>(
    providers.filter((p) => p.hasKey).map((p) => p.name),
  );

  useEffect(() => {
    api("/setup/oauth/providers").then((r) => {
      if (r.ok) setOauthProviders(r.data);
    });
  }, []);

  if (mode === "choose") {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Connect a provider</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Choose how to authenticate with an LLM provider.
          </p>
        </div>

        {connectedProviders.length > 0 && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4" />
            {connectedProviders.length} provider{connectedProviders.length > 1 ? "s" : ""} connected
          </p>
        )}

        <div className="space-y-3">
          {/* OAuth — subscriptions & free */}
          <button
            onClick={() => setMode("oauth")}
            className="w-full flex items-start gap-4 p-4 rounded-lg border border-border hover:border-primary/30 hover:bg-accent/50 text-left transition-all"
          >
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
              <LogIn className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="font-medium text-sm">Login with subscription</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Use your existing Claude, ChatGPT, Copilot, or Google account.
                Includes free options.
              </p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {oauthProviders.slice(0, 3).map((p) => (
                  <Badge key={p.id} variant="secondary" className="text-[10px]">
                    {p.free && <span className="text-emerald-600 mr-0.5">FREE</span>}
                    {p.name.split("(")[0].trim()}
                  </Badge>
                ))}
                {oauthProviders.length > 3 && (
                  <Badge variant="secondary" className="text-[10px]">
                    +{oauthProviders.length - 3} more
                  </Badge>
                )}
              </div>
            </div>
          </button>

          {/* API Key */}
          <button
            onClick={() => setMode("apikey")}
            className="w-full flex items-start gap-4 p-4 rounded-lg border border-border hover:border-primary/30 hover:bg-accent/50 text-left transition-all"
          >
            <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center shrink-0 mt-0.5">
              <Keyboard className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="font-medium text-sm">Enter an API key</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Paste an API key for any provider — OpenAI, Anthropic, Groq, and more.
              </p>
            </div>
          </button>
        </div>
      </div>
    );
  }

  if (mode === "oauth") {
    return (
      <OAuthFlow
        oauthProviders={oauthProviders}
        onBack={() => { setMode("choose"); onOAuthActiveChange?.(false); }}
        onActiveChange={onOAuthActiveChange}
        onComplete={(provider) => {
          setConnectedProviders((prev) => [...new Set([...prev, provider])]);
          setMode("choose");
          onOAuthComplete();
          onOAuthActiveChange?.(false);
        }}
      />
    );
  }

  // API key mode
  return (
    <ApiKeyStep
      providers={providers}
      onSave={async (provider, key) => {
        await onKeySave(provider, key);
        setConnectedProviders((prev) => [...new Set([...prev, provider])]);
      }}
      onBack={() => setMode("choose")}
    />
  );
}

// OAuth flow sub-step
function OAuthFlow({
  oauthProviders,
  onBack,
  onComplete,
  onActiveChange,
}: {
  oauthProviders: OAuthProvider[];
  onBack: () => void;
  onComplete: (provider: string) => void;
  onActiveChange?: (active: boolean) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<string | null>(null);
  const [promptMsg, setPromptMsg] = useState<string | null>(null);
  const [promptPlaceholder, setPromptPlaceholder] = useState<string | null>(null);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const openedUrlRef = useRef<string | null>(null);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const startFlow = async (provider: string) => {
    setSelected(provider);
    setStatus("starting");
    setError(null);
    setAuthUrl(null);
    setPromptMsg(null);
    setProgressMsg(null);
    openedUrlRef.current = null;
    onActiveChange?.(true);

    const res = await api("/setup/oauth/start", {
      method: "POST",
      body: JSON.stringify({ provider }),
    });

    if (!res.ok) {
      setError(res.error || "Failed to start OAuth flow");
      setStatus("error");
      return;
    }

    const id = res.data.flowId;
    setFlowId(id);

    // Start polling
    pollRef.current = setInterval(async () => {
      const r = await api(`/setup/oauth/status/${id}`);
      if (!r.ok) return;
      const d = r.data;

      if (d.authUrl) {
        setAuthUrl(d.authUrl);
        // Auto-open in new tab (only once per URL)
        if (openedUrlRef.current !== d.authUrl) {
          openedUrlRef.current = d.authUrl;
          window.open(d.authUrl, "_blank", "noopener,noreferrer");
        }
      }
      if (d.instructions) setInstructions(d.instructions);
      if (d.progressMessage) setProgressMsg(d.progressMessage);

      if (d.status === "awaiting_browser") {
        setStatus("awaiting_browser");
      } else if (d.status === "awaiting_input") {
        setStatus("awaiting_input");
        setPromptMsg(d.promptMessage || null);
        setPromptPlaceholder(d.promptPlaceholder || null);
      } else if (d.status === "in_progress") {
        setStatus("in_progress");
      } else if (d.status === "complete") {
        if (pollRef.current) clearInterval(pollRef.current);
        setStatus("complete");
        setTimeout(() => onComplete(provider), 1500);
      } else if (d.status === "error") {
        if (pollRef.current) clearInterval(pollRef.current);
        setError(d.error || "OAuth login failed");
        setStatus("error");
      }
    }, 1000);
  };

  const sendInput = async () => {
    if (!flowId || !inputValue) return;
    await api(`/setup/oauth/input/${flowId}`, {
      method: "POST",
      body: JSON.stringify({ value: inputValue }),
    });
    setInputValue("");
    setStatus("in_progress");
    setPromptMsg(null);
  };

  // Provider selection
  if (!selected) {
    const free = oauthProviders.filter((p) => p.free);
    const paid = oauthProviders.filter((p) => !p.free);

    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="text-muted-foreground hover:text-foreground">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Login with subscription</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Select your provider to authenticate via OAuth.
            </p>
          </div>
        </div>

        {free.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Free</p>
            <div className="space-y-1.5">
              {free.map((p) => (
                <button
                  key={p.id}
                  onClick={() => startFlow(p.id)}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg border border-border hover:border-emerald-500/30 hover:bg-emerald-500/5 text-left text-sm transition-all"
                >
                  <div>
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-muted-foreground ml-2">{p.flow}</span>
                  </div>
                  <Badge variant="secondary" className="text-[10px] text-emerald-600">FREE</Badge>
                </button>
              ))}
            </div>
          </div>
        )}

        {paid.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Subscription required</p>
            <div className="space-y-1.5">
              {paid.map((p) => (
                <button
                  key={p.id}
                  onClick={() => startFlow(p.id)}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg border border-border hover:border-primary/30 hover:bg-accent/50 text-left text-sm transition-all"
                >
                  <div>
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-muted-foreground ml-2">{p.flow}</span>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Active flow
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            if (pollRef.current) clearInterval(pollRef.current);
            setSelected(null);
            setFlowId(null);
            setStatus("idle");
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <h2 className="text-xl font-semibold tracking-tight">
          {oauthProviders.find((p) => p.id === selected)?.name}
        </h2>
      </div>

      <div className="space-y-4">
        {/* Starting */}
        {status === "starting" && (
          <div className="flex items-center gap-3 py-8 justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Starting login flow...</span>
          </div>
        )}

        {/* Auth URL — always visible when available */}
        {authUrl && status !== "starting" && status !== "complete" && status !== "error" && (
          <div className="space-y-3">
            {instructions && (
              <p className="text-sm text-muted-foreground">{instructions}</p>
            )}
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Step 1 — Open this link in your browser
            </p>
            <a
              href={authUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-primary/30 bg-primary/5 text-sm font-mono break-all hover:bg-primary/10 transition-all"
            >
              <ExternalLink className="h-4 w-4 shrink-0 text-primary" />
              <span className="text-primary break-all text-xs">{authUrl}</span>
            </a>
          </div>
        )}

        {/* Awaiting input — show prompt below the URL */}
        {status === "awaiting_input" && promptMsg && (
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Step 2 — {promptMsg}
            </p>
            <div className="flex gap-2">
              <Input
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder={promptPlaceholder || ""}
                className="font-mono text-sm"
                onKeyDown={(e) => e.key === "Enter" && sendInput()}
                autoFocus
              />
              <Button onClick={sendInput} disabled={!inputValue} size="sm">
                Submit
              </Button>
            </div>
          </div>
        )}

        {/* Waiting for browser (no input needed yet) */}
        {(status === "awaiting_browser" || status === "in_progress") && !promptMsg && (
          <p className="text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            {progressMsg || "Waiting for browser authentication..."}
          </p>
        )}

        {/* Complete */}
        {status === "complete" && (
          <div className="flex items-center gap-3 py-8 justify-center text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-5 w-5" />
            <span className="text-sm font-medium">Login successful!</span>
          </div>
        )}

        {/* Error */}
        {status === "error" && error && (
          <div className="space-y-3">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={() => startFlow(selected)}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// API key sub-step
function ApiKeyStep({
  providers,
  onSave,
  onBack,
}: {
  providers: Provider[];
  onSave: (provider: string, key: string) => Promise<void>;
  onBack: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string[]>(
    providers.filter((p) => p.hasKey).map((p) => p.name),
  );

  const popularProviders = ["anthropic", "openai", "google", "groq", "openrouter", "xai"];
  const sorted = [...providers].sort((a, b) => {
    const ai = popularProviders.indexOf(a.name);
    const bi = popularProviders.indexOf(b.name);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.name.localeCompare(b.name);
  });

  const handleSave = async () => {
    if (!selected || !apiKey) return;
    setSaving(true);
    try {
      await onSave(selected, apiKey);
      setSaved((prev) => [...prev, selected]);
      setApiKey("");
      setSelected(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Enter an API key</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Your key is stored locally in{" "}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">.polpo/.env</code>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-[280px] overflow-y-auto pr-1">
        {sorted.map((p) => {
          const isSaved = saved.includes(p.name);
          return (
            <button
              key={p.name}
              onClick={() => { if (!isSaved) { setSelected(p.name); setApiKey(""); } }}
              className={cn(
                "relative flex items-center gap-2 px-3 py-2.5 rounded-lg border text-left text-sm transition-all",
                isSaved
                  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
                  : selected === p.name
                    ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                    : "border-border hover:border-primary/30 hover:bg-accent/50",
              )}
            >
              {isSaved && <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
              <span className="font-medium truncate">{p.name}</span>
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {providers.find((p) => p.name === selected)?.envVar}
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="pr-10 font-mono text-sm"
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button onClick={handleSave} disabled={!apiKey || saving} size="sm">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
          </div>
        </div>
      )}

      {saved.length > 0 && !selected && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
          <CheckCircle2 className="h-4 w-4" />
          {saved.length} provider{saved.length > 1 ? "s" : ""} connected
        </p>
      )}
    </div>
  );
}

// Step 2: Model selection
function ModelStep({
  onSelect,
  configuredProviders,
}: {
  onSelect: (model: string) => void;
  configuredProviders: string[];
}) {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api("/setup/models")
      .then((r) => {
        if (r.ok) {
          const all = r.data as Model[];
          // Filter to configured providers only, deduplicate by id
          const seen = new Set<string>();
          const filtered = all
            .filter((m) => configuredProviders.includes(m.provider))
            .filter((m) => {
              const key = `${m.provider}:${m.id}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
          setModels(filtered);
        }
      })
      .finally(() => setLoading(false));
  }, [configuredProviders]);

  const fmtCost = (n: number) => (n === 0 ? "free" : n < 1 ? `$${n.toFixed(2)}/M` : `$${n.toFixed(0)}/M`);

  const q = search.toLowerCase().trim();
  const filtered = q
    ? models.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q),
      )
    : models;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Choose your model</h2>
        <p className="text-sm text-muted-foreground mt-1">
          This model powers the orchestrator — it plans tasks, reviews code, and coordinates agents.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : models.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No models found. Make sure you added an API key in the previous step.
        </p>
      ) : (
        <>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models..."
            className="pl-9 text-sm"
          />
        </div>
        <div className="space-y-1.5 max-h-[280px] overflow-y-auto pr-1">
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No models match "{search}"
            </p>
          ) : filtered.map((m) => (
            <button
              key={`${m.provider}:${m.id}`}
              onClick={() => {
                const spec = `${m.provider}:${m.id}`;
                setSelected(spec);
                onSelect(spec);
              }}
              className={cn(
                "w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-left text-sm transition-all",
                selected === `${m.provider}:${m.id}`
                  ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                  : "border-border hover:border-primary/30 hover:bg-accent/50",
              )}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-medium truncate">{m.name}</span>
                <span className="text-xs text-muted-foreground shrink-0">{m.provider}</span>
                {m.reasoning && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                    <Zap className="h-2.5 w-2.5 mr-0.5" />reasoning
                  </Badge>
                )}
              </div>
              <span className="text-xs text-muted-foreground shrink-0 ml-2">
                {m.cost.input === 0 && m.cost.output === 0
                  ? <Badge variant="secondary" className="text-[10px] px-1.5 py-0 text-emerald-600">free</Badge>
                  : `${fmtCost(m.cost.input)} / ${fmtCost(m.cost.output)}`}
              </span>
            </button>
          ))}
        </div>
        </>
      )}
    </div>
  );
}

// Step 3: Agent config
function AgentStep({
  agentName,
  agentRole,
  onChangeName,
  onChangeRole,
}: {
  agentName: string;
  agentRole: string;
  onChangeName: (v: string) => void;
  onChangeRole: (v: string) => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Name your first agent</h2>
        <p className="text-sm text-muted-foreground mt-1">
          This is the first AI coding agent in your team. You can add more later.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Agent name
          </label>
          <Input
            value={agentName}
            onChange={(e) => onChangeName(e.target.value)}
            placeholder="agent-1"
            className="font-mono"
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Role
          </label>
          <Input
            value={agentRole}
            onChange={(e) => onChangeRole(e.target.value)}
            placeholder="founder"
          />
          <p className="text-xs text-muted-foreground">
            Describes what this agent does — e.g. "founder", "developer", "designer"
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Main setup wizard ──

export function SetupPage() {
  const [step, setStep] = useState(0);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [agentName, setAgentName] = useState("agent-1");
  const [agentRole, setAgentRole] = useState("founder");
  const [workDir, setWorkDir] = useState("");
  const [orgName, setOrgName] = useState("");
  const [completing, setCompleting] = useState(false);
  const [oauthActive, setOauthActive] = useState(false);
  const [loading, setLoading] = useState(true);

  const STEPS = [
    { icon: FolderOpen, label: "Project" },
    { icon: KeyRound, label: "Provider" },
    { icon: Cpu, label: "Model" },
    { icon: Sparkles, label: "Agent" },
  ];

  // Load status on mount
  useEffect(() => {
    api("/setup/status")
      .then((r) => {
        if (r.ok) {
          const status = r.data as SetupStatus;
          setWorkDir(status.workDir);
          setOrgName(status.orgName);
          setProviders(status.detectedProviders);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const refreshProviders = useCallback(async () => {
    const r = await api("/setup/providers");
    if (r.ok) setProviders(r.data);
  }, []);

  const handleSaveKey = useCallback(async (provider: string, key: string) => {
    const result = await api("/setup/api-key", {
      method: "POST",
      body: JSON.stringify({ provider, apiKey: key }),
    });
    if (result.ok) await refreshProviders();
  }, [refreshProviders]);

  const handleComplete = async () => {
    setCompleting(true);
    try {
      await api("/setup/complete", {
        method: "POST",
        body: JSON.stringify({
          orgName: orgName || undefined,
          workDir: workDir || undefined,
          model: selectedModel || undefined,
          agentName: agentName || "agent-1",
          agentRole: agentRole || "founder",
        }),
      });
      window.location.href = "/";
    } catch {
      setCompleting(false);
    }
  };

  // Auto-derive org name from workDir when user changes the directory
  const handleChangeDir = (dir: string) => {
    setWorkDir(dir);
    const parts = dir.replace(/\/+$/, "").split("/");
    const derived = parts[parts.length - 1] || "";
    if (derived) setOrgName(derived);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Subtle gradient background */}
      <div className="fixed inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/[0.03] via-transparent to-transparent pointer-events-none" />

      <div className="relative flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-lg space-y-8">
          {/* Logo */}
          <div className="text-center space-y-2">
            <h1 className="text-3xl font-bold tracking-tight">
              <span className="bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
                Polpo
              </span>
            </h1>
            <p className="text-sm text-muted-foreground">
              Set up your AI agent orchestrator
            </p>
          </div>

          {/* Step indicator */}
          <div className="flex justify-center">
            <StepIndicator current={step} total={STEPS.length} />
          </div>

          {/* Card */}
          <Card className="border-border/60 shadow-lg shadow-black/[0.03]">
            <CardContent className="pt-6 pb-6 px-6 min-h-[320px] flex flex-col">
              <div className="flex-1">
                {step === 0 && (
                  <ProjectStep
                    workDir={workDir}
                    orgName={orgName}
                    onChangeDir={handleChangeDir}
                    onChangeOrg={setOrgName}
                  />
                )}
                {step === 1 && (
                  <AuthStep
                    providers={providers}
                    onKeySave={handleSaveKey}
                    onOAuthComplete={refreshProviders}
                    onOAuthActiveChange={setOauthActive}
                  />
                )}
                {step === 2 && (
                  <ModelStep
                    onSelect={setSelectedModel}
                    configuredProviders={providers.filter((p) => p.hasKey).map((p) => p.name)}
                  />
                )}
                {step === 3 && (
                  <AgentStep
                    agentName={agentName}
                    agentRole={agentRole}
                    onChangeName={setAgentName}
                    onChangeRole={setAgentRole}
                  />
                )}
              </div>

              {/* Navigation — hidden during active OAuth flow */}
              {!oauthActive && (
              <div className="flex items-center justify-between pt-6 mt-6 border-t border-border/40">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setStep(Math.max(0, step - 1))}
                  disabled={step === 0}
                  className="gap-1"
                >
                  <ChevronLeft className="h-4 w-4" /> Back
                </Button>

                {step < STEPS.length - 1 ? (
                  <Button
                    size="sm"
                    onClick={() => setStep(step + 1)}
                    className="gap-1"
                  >
                    Next <ChevronRight className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={handleComplete}
                    disabled={completing}
                    className="gap-1.5"
                  >
                    {completing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        Complete setup <ArrowRight className="h-4 w-4" />
                      </>
                    )}
                  </Button>
                )}
              </div>
              )}
            </CardContent>
          </Card>

          {/* CLI hint */}
          <p className="text-center text-xs text-muted-foreground/60">
            You can also run setup via CLI:{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded font-mono">polpo setup</code>
          </p>
        </div>
      </div>
    </div>
  );
}
