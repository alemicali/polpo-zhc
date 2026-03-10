import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { config } from "@/lib/config";
import {
  KeyRound,
  Sparkles,
  Cpu,
  FolderOpen,
  Folder,
  FolderPlus,
  Home,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  Check,
  X,
  Eye,
  EyeOff,
  Loader2,
  Zap,
  ArrowRight,
  ExternalLink,
  LogIn,
  Keyboard,
  Pencil,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──

interface Provider {
  name: string;
  envVar: string;
  hasKey: boolean;
  source?: string; // "env" | "oauth" | "none"
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
  initialized: boolean;
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

interface DirEntry {
  name: string;
  path: string;
  hasPolpoConfig: boolean;
}

interface BrowseResult {
  current: string;
  parent: string | null;
  dirs: DirEntry[];
}

function DirectoryPickerDialog({
  open,
  onOpenChange,
  initialPath,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPath: string;
  onSelect: (path: string) => void;
}) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("New Folder");
  const [renamingDir, setRenamingDir] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const newFolderRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  const browse = useCallback(async (path: string) => {
    setLoading(true);
    setSearch("");
    setCreatingFolder(false);
    setRenamingDir(null);
    try {
      const r = await api(`/filesystem/browse?path=${encodeURIComponent(path)}`);
      if (r.ok) {
        setData(r.data);
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) browse(initialPath || "");
  }, [open]);

  useEffect(() => {
    if (creatingFolder) setTimeout(() => newFolderRef.current?.select(), 50);
  }, [creatingFolder]);

  useEffect(() => {
    if (renamingDir) setTimeout(() => renameRef.current?.select(), 50);
  }, [renamingDir]);

  const segments = (data?.current || "").split("/").filter(Boolean);

  const handleBreadcrumbNav = (index: number) => {
    if (index === -1) browse("/");
    else browse("/" + segments.slice(0, index + 1).join("/"));
  };

  const handleConfirm = () => {
    if (data?.current) {
      onSelect(data.current);
      onOpenChange(false);
    }
  };

  const handleCreateFolder = async () => {
    if (!data?.current || !newFolderName.trim()) return;
    const fullPath = data.current + "/" + newFolderName.trim();
    const r = await api("/filesystem/mkdir", {
      method: "POST",
      body: JSON.stringify({ path: fullPath }),
    });
    if (r.ok) {
      setCreatingFolder(false);
      browse(data.current);
    }
  };

  const handleRename = async (dir: DirEntry) => {
    if (!renameValue.trim() || renameValue === dir.name) {
      setRenamingDir(null);
      return;
    }
    const r = await api("/filesystem/rename", {
      method: "POST",
      body: JSON.stringify({ path: dir.path, newName: renameValue.trim() }),
    });
    if (r.ok) {
      setRenamingDir(null);
      browse(data!.current);
    }
  };

  const q = search.toLowerCase().trim();
  const filteredDirs = data?.dirs.filter((d) => !q || d.name.toLowerCase().includes(q)) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle className="text-base">Select a folder</DialogTitle>
          <DialogDescription className="text-xs">
            Navigate to your project directory
          </DialogDescription>
        </DialogHeader>

        {/* Toolbar: breadcrumb + actions */}
        <div className="flex items-center gap-2 px-5 py-2.5 border-b">
          {/* Breadcrumb */}
          <div className="flex items-center gap-0.5 text-sm overflow-x-auto flex-1 min-w-0">
            <button
              type="button"
              onClick={() => handleBreadcrumbNav(-1)}
              className="shrink-0 p-1 rounded hover:bg-accent/40 transition-colors text-muted-foreground hover:text-foreground"
            >
              <Home className="h-3.5 w-3.5" />
            </button>
            {segments.map((seg, i) => (
              <div key={i} className="flex items-center gap-0.5 min-w-0">
                <ChevronRight className="h-3 w-3 text-muted-foreground/40 shrink-0" />
                {i === segments.length - 1 ? (
                  <span className="font-medium text-foreground truncate text-sm">{seg}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleBreadcrumbNav(i)}
                    className="truncate px-1 py-0.5 rounded hover:bg-accent/40 transition-colors text-muted-foreground hover:text-foreground text-sm"
                  >
                    {seg}
                  </button>
                )}
              </div>
            ))}
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground ml-1 shrink-0" />}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => { setCreatingFolder(true); setNewFolderName("New Folder"); }}
              title="New folder"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </Button>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter..."
                className="h-7 w-36 pl-7 text-xs"
              />
            </div>
          </div>
        </div>

        {/* Directory listing */}
        <div ref={scrollRef} className="h-96 overflow-y-auto">
          {/* Parent directory */}
          {data?.parent && (
            <button
              type="button"
              onClick={() => browse(data.parent!)}
              className="w-full flex items-center gap-3 px-5 py-2.5 text-left hover:bg-accent/40 transition-colors"
            >
              <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-sm text-muted-foreground">..</span>
            </button>
          )}

          {/* New folder inline */}
          {creatingFolder && (
            <div className="flex items-center gap-3 px-5 py-2">
              <FolderPlus className="h-4 w-4 text-primary shrink-0" />
              <Input
                ref={newFolderRef}
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateFolder();
                  if (e.key === "Escape") setCreatingFolder(false);
                }}
                className="h-7 text-sm flex-1"
                autoFocus
              />
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={handleCreateFolder}>
                <Check className="h-3.5 w-3.5 text-emerald-500" />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setCreatingFolder(false)}>
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
          )}

          {filteredDirs.map((dir) => (
            <div key={dir.path} className="group flex items-center gap-3 px-5 py-2.5 hover:bg-accent/40 transition-colors">
              {renamingDir === dir.path ? (
                <>
                  <Folder className="h-4 w-4 text-sky-400 shrink-0" />
                  <Input
                    ref={renameRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRename(dir);
                      if (e.key === "Escape") setRenamingDir(null);
                    }}
                    className="h-7 text-sm flex-1"
                    autoFocus
                  />
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => handleRename(dir)}>
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setRenamingDir(null)}>
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => browse(dir.path)}
                    className="flex items-center gap-3 flex-1 min-w-0 text-left"
                  >
                    <Folder className="h-4 w-4 text-sky-400 shrink-0" />
                    <span className="text-sm truncate">{dir.name}</span>
                    {dir.hasPolpoConfig && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                        polpo
                      </Badge>
                    )}
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => { setRenamingDir(dir.path); setRenameValue(dir.name); }}
                    title="Rename"
                  >
                    <Pencil className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </>
              )}
            </div>
          ))}

          {data && filteredDirs.length === 0 && (
            <div className="flex items-center justify-center h-32">
              <p className="text-sm text-muted-foreground">
                {q ? `No folders matching "${search}"` : "Empty folder"}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="px-5 py-3 border-t bg-muted/30">
          <div className="flex items-center gap-3 w-full">
            <code className="text-xs text-muted-foreground font-mono truncate flex-1">
              {data?.current || initialPath}
            </code>
            <Button type="button" size="sm" onClick={handleConfirm}>
              Select folder
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
  const [pickerOpen, setPickerOpen] = useState(false);

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
          <div className="flex gap-2">
            <Input
              value={workDir}
              onChange={(e) => onChangeDir(e.target.value)}
              placeholder="/path/to/your/project"
              className="font-mono text-sm flex-1"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => setPickerOpen(true)}
              className="shrink-0"
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Config will be saved to <code className="bg-muted px-1 py-0.5 rounded">{workDir}/.polpo/polpo.json</code>
          </p>

          <DirectoryPickerDialog
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            initialPath={workDir}
            onSelect={onChangeDir}
          />
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
  onDisconnect,
}: {
  providers: Provider[];
  onKeySave: (provider: string, key: string) => Promise<void>;
  onOAuthComplete: () => void;
  onOAuthActiveChange?: (active: boolean) => void;
  onDisconnect?: (provider: string) => Promise<void>;
}) {
  type AuthMode = "choose" | "add" | "oauth" | "apikey";
  const [mode, setMode] = useState<AuthMode>("choose");
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [connectedProviders, setConnectedProviders] = useState<string[]>(
    providers.filter((p) => p.hasKey).map((p) => p.name),
  );
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  useEffect(() => {
    api("/providers/oauth").then((r) => {
      if (r.ok) setOauthProviders(r.data);
    });
  }, []);

  const connected = providers.filter((p) => connectedProviders.includes(p.name) && p.hasKey);

  const handleDisconnect = async (provider: Provider) => {
    setDisconnecting(provider.name);
    try {
      await onDisconnect?.(provider.name);
      setConnectedProviders((prev) => prev.filter((n) => n !== provider.name));
    } finally {
      setDisconnecting(null);
    }
  };

  if (mode === "choose") {
    // No providers connected — force user to add one
    if (connected.length === 0) {
      return (
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
      );
    }

    // Has providers — show list + "Add provider" button
    return (
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
                onClick={() => handleDisconnect(p)}
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
    );
  }

  if (mode === "add") {
    return (
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

    const res = await api("/providers/oauth/start", {
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
      const r = await api(`/providers/oauth/status/${id}`);
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
    await api(`/providers/oauth/input/${flowId}`, {
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
  providerSources,
}: {
  onSelect: (model: string) => void;
  configuredProviders: string[];
  providerSources: Record<string, string>; // provider name → "env" | "oauth"
}) {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<string>("all");

  useEffect(() => {
    api("/providers/models")
      .then((r) => {
        if (r.ok) {
          const all = r.data as Model[];
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

  // Unique providers that have models
  const availableProviders = [...new Set(models.map((m) => m.provider))].sort();

  const q = search.toLowerCase().trim();
  const filtered = models.filter((m) => {
    if (providerFilter !== "all" && m.provider !== providerFilter) return false;
    if (q && !m.name.toLowerCase().includes(q) && !m.id.toLowerCase().includes(q) && !m.provider.toLowerCase().includes(q)) return false;
    return true;
  });

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
        {/* Provider filter pills */}
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setProviderFilter("all")}
            className={cn(
              "px-2.5 py-1 rounded-full text-xs font-medium transition-all",
              providerFilter === "all"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-accent",
            )}
          >
            All ({models.length})
          </button>
          {availableProviders.map((prov) => {
            const count = models.filter((m) => m.provider === prov).length;
            const source = providerSources[prov];
            return (
              <button
                key={prov}
                type="button"
                onClick={() => setProviderFilter(prov === providerFilter ? "all" : prov)}
                className={cn(
                  "px-2.5 py-1 rounded-full text-xs font-medium transition-all flex items-center gap-1",
                  providerFilter === prov
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-accent",
                )}
              >
                <span className="capitalize">{prov}</span>
                <span className="opacity-60">({count})</span>
                {source && (
                  <Badge
                    variant="secondary"
                    className={cn(
                      "text-[9px] px-1 py-0 ml-0.5",
                      providerFilter === prov ? "bg-primary-foreground/20 text-primary-foreground" : "",
                    )}
                  >
                    {source === "oauth" ? "sub" : "key"}
                  </Badge>
                )}
              </button>
            );
          })}
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models..."
            className="pl-9 text-sm"
          />
        </div>
        <div className="space-y-1.5 max-h-[240px] overflow-y-auto pr-1">
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No models match "{search || providerFilter}"
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
    api("/config/status")
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
    const r = await api("/providers");
    if (r.ok) setProviders(r.data);
  }, []);

  const handleSaveKey = useCallback(async (provider: string, key: string) => {
    const result = await api(`/providers/${provider}/api-key`, {
      method: "POST",
      body: JSON.stringify({ apiKey: key, workDir }),
    });
    if (result.ok) await refreshProviders();
  }, [refreshProviders, workDir]);

  const handleDisconnect = useCallback(async (provider: string) => {
    await api(`/providers/${provider}/api-key`, {
      method: "DELETE",
      body: JSON.stringify({ workDir }),
    });
    await refreshProviders();
  }, [refreshProviders, workDir]);

  const handleComplete = async () => {
    setCompleting(true);
    try {
      await api("/config/initialize", {
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
                    onDisconnect={handleDisconnect}
                  />
                )}
                {step === 2 && (
                  <ModelStep
                    onSelect={setSelectedModel}
                    configuredProviders={providers.filter((p) => p.hasKey).map((p) => p.name)}
                    providerSources={Object.fromEntries(
                      providers.filter((p) => p.hasKey).map((p) => [p.name, p.source || "env"]),
                    )}
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
                {step > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setStep(step - 1)}
                    className="gap-1"
                  >
                    <ChevronLeft className="h-4 w-4" /> Back
                  </Button>
                ) : (
                  <div />
                )}

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
