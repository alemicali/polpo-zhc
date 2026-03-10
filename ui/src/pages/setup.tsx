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
  Loader2,
  ArrowRight,
  Pencil,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AuthStep } from "@/components/shared/provider-auth";
import type { Provider } from "@/components/shared/provider-auth";
import { ModelPicker } from "@/components/shared/model-picker";

// ── Types ──

interface SetupStatus {
  initialized: boolean;
  hasConfig: boolean;
  hasProviders: boolean;
  detectedProviders: Provider[];
  workDir: string;
  orgName: string;
}

// ── API helpers ──

const api = async (path: string, init?: RequestInit) => {
  try {
    const headers: Record<string, string> = { ...init?.headers as Record<string, string> };
    if (init?.body) headers["Content-Type"] = "application/json";
    const res = await fetch(`${config.baseUrl}/api/v1${path}`, {
      ...init,
      headers,
    });
    const data = await res.json();
    return data;
  } catch {
    return { ok: false, error: "Could not connect to server" };
  }
};

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

// Step 2: Model selection — uses shared ModelPicker
function ModelStep({
  onSelect,
  configuredProviders,
  providerSources,
}: {
  onSelect: (model: string) => void;
  configuredProviders: string[];
  providerSources: Record<string, string>;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <ModelPicker
      configuredProviders={configuredProviders}
      providerSources={providerSources}
      value={selected}
      onSelect={(spec) => {
        setSelected(spec);
        onSelect(spec);
      }}
      apiFetch={api}
      heading="Choose your model"
      subheading="This model powers the orchestrator — it plans tasks, reviews code, and coordinates agents."
    />
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
  const [alreadyInitialized, setAlreadyInitialized] = useState(false);

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
          if (status.initialized) {
            setAlreadyInitialized(true);
          } else {
            setWorkDir(status.workDir);
            setOrgName(status.orgName);
            setProviders(status.detectedProviders);
          }
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const refreshProviders = useCallback(async () => {
    const r = await api("/providers");
    if (r.ok) setProviders(r.data);
  }, []);

  const handleSaveKey = useCallback(async (provider: string, key: string): Promise<boolean> => {
    const result = await api(`/providers/${provider}/api-key`, {
      method: "POST",
      body: JSON.stringify({ apiKey: key, workDir }),
    });
    if (result.ok) {
      await refreshProviders();
      return true;
    }
    return false;
  }, [refreshProviders, workDir]);

  const handleDisconnect = useCallback(async (provider: string) => {
    await api(`/providers/${provider}/disconnect`, {
      method: "DELETE",
      body: JSON.stringify({ workDir }),
    });
    await refreshProviders();
  }, [refreshProviders, workDir]);

  const [setupError, setSetupError] = useState<string | null>(null);

  const handleComplete = async () => {
    setCompleting(true);
    setSetupError(null);
    try {
      const result = await api("/config/initialize", {
        method: "POST",
        body: JSON.stringify({
          orgName: orgName || undefined,
          workDir: workDir || undefined,
          model: selectedModel || undefined,
          agentName: agentName || "agent-1",
          agentRole: agentRole || "founder",
        }),
      });
      if (result.ok) {
        // Full reload to re-check setup status — works for both file:// (HashRouter) and http (BrowserRouter)
        window.location.href = window.location.pathname + window.location.search + "#/";
      } else {
        setSetupError(result.error || "Setup failed. Check server logs.");
        setCompleting(false);
      }
    } catch {
      setSetupError("Could not connect to server.");
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

  // Guard: if already initialized, don't show setup wizard
  if (alreadyInitialized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 pb-6 px-6 text-center space-y-4">
            <div className="h-12 w-12 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto">
              <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <h2 className="text-xl font-semibold">Already configured</h2>
            <p className="text-sm text-muted-foreground">
              Polpo is already set up and running. To change providers, models, or other settings, use the configuration page.
            </p>
            <Button onClick={() => { window.location.href = window.location.pathname + window.location.search + "#/config"; }} className="gap-1.5">
              Go to Configuration <ArrowRight className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
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
                    apiFetch={api}
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
                    disabled={
                      (step === 0 && !workDir) ||
                      (step === 1 && !providers.some((p) => p.hasKey))
                    }
                    className="gap-1"
                  >
                    Next <ChevronRight className="h-4 w-4" />
                  </Button>
                ) : (
                  <div className="flex items-center gap-3">
                    {setupError && (
                      <p className="text-sm text-destructive">{setupError}</p>
                    )}
                    <Button
                      size="sm"
                      onClick={handleComplete}
                      disabled={completing || !providers.some((p) => p.hasKey)}
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
                  </div>
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
