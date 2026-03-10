/**
 * Shared provider authentication components.
 *
 * Used by both the setup wizard (setup.tsx) and the config page (config.tsx)
 * to manage provider connections: OAuth login, API key entry, and disconnect.
 *
 * Each component receives an `apiFetch` prop for HTTP calls so the parent
 * page can supply its own fetch wrapper (setup has its own `api()`, config
 * uses the SDK client or a similar helper).
 */

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  Keyboard,
  Loader2,
  LogIn,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";

// ── Types ──

export interface Provider {
  name: string;
  envVar: string;
  hasKey: boolean;
  source?: string; // "env" | "oauth" | "none"
}

export interface OAuthProvider {
  id: string;
  name: string;
  flow: string;
  free: boolean;
}

/** Generic API fetch function — returns { ok, data?, error? } */
export type ApiFetch = (path: string, init?: RequestInit) => Promise<{ ok: boolean; data?: any; error?: string }>;

// ── AuthStep ──
// Top-level auth management: shows connected providers, disconnect, and routes
// to OAuth or API key sub-steps.

export function AuthStep({
  providers,
  onKeySave,
  onOAuthComplete,
  onOAuthActiveChange,
  onDisconnect,
  apiFetch,
}: {
  providers: Provider[];
  onKeySave: (provider: string, key: string) => Promise<boolean>;
  onOAuthComplete: () => void;
  onOAuthActiveChange?: (active: boolean) => void;
  onDisconnect?: (provider: string) => Promise<void>;
  apiFetch: ApiFetch;
}) {
  type AuthMode = "choose" | "add" | "oauth" | "apikey";
  const [mode, setMode] = useState<AuthMode>("choose");
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [connectedProviders, setConnectedProviders] = useState<string[]>(
    providers.filter((p) => p.hasKey).map((p) => p.name),
  );
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<Provider | null>(null);

  // Sync connectedProviders when providers list changes (e.g. after OAuth or refresh)
  useEffect(() => {
    const withKey = providers.filter((p) => p.hasKey).map((p) => p.name);
    setConnectedProviders((prev) => {
      const merged = new Set([...prev, ...withKey]);
      // Remove any that no longer have a key
      for (const name of prev) {
        if (!withKey.includes(name)) merged.delete(name);
      }
      return [...merged];
    });
  }, [providers]);

  useEffect(() => {
    apiFetch("/providers/oauth").then((r) => {
      if (r.ok) setOauthProviders(r.data);
    });
  }, [apiFetch]);

  const connected = providers.filter((p) => connectedProviders.includes(p.name) && p.hasKey);

  const handleDisconnectConfirm = async () => {
    if (!confirmTarget) return;
    setDisconnecting(confirmTarget.name);
    setConfirmTarget(null);
    try {
      await onDisconnect?.(confirmTarget.name);
      setConnectedProviders((prev) => prev.filter((n) => n !== confirmTarget.name));
    } finally {
      setDisconnecting(null);
    }
  };

  const confirmDialog = (
    <ConfirmDialog
      open={!!confirmTarget}
      onOpenChange={(open) => { if (!open) setConfirmTarget(null); }}
      title={`Disconnect ${confirmTarget?.name ?? ""}?`}
      description="This will remove the API key and any OAuth sessions for this provider."
      confirmLabel="Disconnect"
      destructive
      onConfirm={handleDisconnectConfirm}
    />
  );

  if (mode === "choose") {
    // No providers connected — force user to add one
    if (connected.length === 0) {
      return (
        <>
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">Connect a provider</h2>
              <p className="text-sm text-muted-foreground mt-1">
                You need at least one LLM provider to continue. Choose how to connect.
              </p>
            </div>

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
          {confirmDialog}
        </>
      );
    }

    // Has providers — show list + "Add provider" button
    return (
      <>
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Your providers</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {connected.length} provider{connected.length > 1 ? "s" : ""} connected. You can add more or continue to the next step.
            </p>
          </div>

          <div className="space-y-1.5">
            {connected.map((p) => (
              <div
                key={p.name}
                className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-emerald-500/20 bg-emerald-500/5"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                  <span className="text-sm font-medium capitalize">{p.name}</span>
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    {p.source === "oauth" ? "subscription" : "API key"}
                  </Badge>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmTarget(p)}
                  disabled={disconnecting === p.name}
                  className="text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 h-7 px-2"
                >
                  {disconnecting === p.name ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    "Disconnect"
                  )}
                </Button>
              </div>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setMode("add")}
            className="w-full gap-1.5"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Add another provider
          </Button>
        </div>
        {confirmDialog}
      </>
    );
  }

  if (mode === "add") {
    return (
      <>
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <button onClick={() => setMode("choose")} className="text-muted-foreground hover:text-foreground">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div>
              <h2 className="text-xl font-semibold tracking-tight">Add a provider</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                Choose how to connect another LLM provider.
              </p>
            </div>
          </div>

          <div className="space-y-3">
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
                  Claude, ChatGPT, Copilot, or Google. Includes free options.
                </p>
              </div>
            </button>

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
                  OpenAI, Anthropic, Groq, and more.
                </p>
              </div>
            </button>
          </div>
        </div>
        {confirmDialog}
      </>
    );
  }

  if (mode === "oauth") {
    return (
      <>
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
          apiFetch={apiFetch}
        />
        {confirmDialog}
      </>
    );
  }

  // API key mode
  return (
    <>
      <ApiKeyStep
        providers={providers}
        onSave={async (provider, key) => {
          const ok = await onKeySave(provider, key);
          if (ok) setConnectedProviders((prev) => [...new Set([...prev, provider])]);
          return ok;
        }}
        onBack={() => setMode("choose")}
      />
      {confirmDialog}
    </>
  );
}

// ── OAuthFlow ──
// Multi-step OAuth login: provider selection -> start flow -> poll status -> complete.

export function OAuthFlow({
  oauthProviders,
  onBack,
  onComplete,
  onActiveChange,
  apiFetch,
  initialProvider,
}: {
  oauthProviders: OAuthProvider[];
  onBack: () => void;
  onComplete: (provider: string) => void;
  onActiveChange?: (active: boolean) => void;
  apiFetch: ApiFetch;
  /** When set, skip provider selection and start the flow immediately. */
  initialProvider?: string;
}) {
  const [selected, setSelected] = useState<string | null>(initialProvider ?? null);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>(initialProvider ? "starting" : "idle");
  const startedRef = useRef(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<string | null>(null);
  const [promptMsg, setPromptMsg] = useState<string | null>(null);
  const [promptPlaceholder, setPromptPlaceholder] = useState<string | null>(null);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedUrlRef = useRef<string | null>(null);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  // Auto-start when initialProvider is set (skip provider selection)
  useEffect(() => {
    if (initialProvider && !startedRef.current) {
      startedRef.current = true;
      startFlow(initialProvider);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProvider]);

  const startFlow = async (provider: string) => {
    setSelected(provider);
    setStatus("starting");
    setError(null);
    setAuthUrl(null);
    setPromptMsg(null);
    setProgressMsg(null);
    openedUrlRef.current = null;
    onActiveChange?.(true);

    const res = await apiFetch("/providers/oauth/start", {
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

    // Start polling (with 5-minute timeout)
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (pollRef.current) clearInterval(pollRef.current);
      setError("Authentication timed out. Please try again.");
      setStatus("error");
    }, 5 * 60 * 1000);

    pollRef.current = setInterval(async () => {
      const r = await apiFetch(`/providers/oauth/status/${id}`);
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
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setStatus("complete");
        setTimeout(() => onComplete(provider), 1500);
      } else if (d.status === "error") {
        if (pollRef.current) clearInterval(pollRef.current);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setError(d.error || "OAuth login failed");
        setStatus("error");
      }
    }, 1000);
  };

  const sendInput = async () => {
    if (!flowId || !inputValue) return;
    await apiFetch(`/providers/oauth/input/${flowId}`, {
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

// ── ApiKeyStep ──
// Grid of providers with inline API key input.

export function ApiKeyStep({
  providers,
  onSave,
  onBack,
  initialProvider,
}: {
  providers: Provider[];
  onSave: (provider: string, key: string) => Promise<boolean>;
  onBack: () => void;
  /** When set, pre-select this provider and skip the provider grid. */
  initialProvider?: string;
}) {
  const [selected, setSelected] = useState<string | null>(initialProvider ?? null);
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

  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!selected || !apiKey) return;
    setSaving(true);
    setSaveError(null);
    try {
      const ok = await onSave(selected, apiKey);
      if (ok) {
        setSaved((prev) => [...prev, selected]);
        setApiKey("");
        setSelected(null);
      } else {
        setSaveError("Failed to save API key. Check the server.");
      }
    } catch {
      setSaveError("Could not connect to server.");
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
          <h2 className="text-xl font-semibold tracking-tight">
            {initialProvider ? `API key for ${initialProvider}` : "Enter an API key"}
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Your key is stored locally in{" "}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">.polpo/.env</code>
          </p>
        </div>
      </div>

      {!initialProvider && (
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
      )}

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
          {saveError && (
            <p className="text-sm text-destructive">{saveError}</p>
          )}
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
