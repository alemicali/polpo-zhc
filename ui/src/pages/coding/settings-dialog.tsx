import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { apiUrl } from "@/lib/config";
import { cn } from "@/lib/utils";
import type { CodingAgentKind, CodingCapabilities } from "./types";
import { DEFAULT_PR_COMMAND, useCodingSettings } from "./coding-settings";

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

const AGENT_LABEL: Record<CodingAgentKind, string> = {
  terminal: "Shell",
  claude: "Claude",
  codex: "Codex",
};

type GitIdentity = {
  git: { name: string | null; email: string | null };
  gh: { login: string; url: string | null } | null;
};

export function CodingSettingsDialog({ open, onOpenChange }: Props) {
  const [settings, update] = useCodingSettings();
  const [capabilities, setCapabilities] = useState<CodingCapabilities | null>(null);
  const [identity, setIdentity] = useState<GitIdentity | null>(null);
  const [identityState, setIdentityState] = useState<"loading" | "ok" | "error">("loading");
  const [newPath, setNewPath] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch(apiUrl("/api/v1/coding/capabilities"), { credentials: "include" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ok) throw new Error("capabilities");
        return body.data as CodingCapabilities;
      })
      .then((data) => { if (!cancelled) setCapabilities(data); })
      .catch(() => { if (!cancelled) setCapabilities(null); });
    setIdentityState("loading");
    fetch(apiUrl("/api/v1/coding/git-identity"), { credentials: "include" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ok) throw new Error("git-identity");
        return body.data as GitIdentity;
      })
      .then((data) => { if (!cancelled) { setIdentity(data); setIdentityState("ok"); } })
      .catch(() => { if (!cancelled) { setIdentity(null); setIdentityState("error"); } });
    return () => { cancelled = true; };
  }, [open]);

  const setCommand = (kind: CodingAgentKind, value: string) => {
    update((prev) => ({
      ...prev,
      agentCommands: { ...prev.agentCommands, [kind]: value },
    }));
  };

  const resetCommand = (kind: CodingAgentKind) => {
    update((prev) => {
      const { [kind]: _gone, ...rest } = prev.agentCommands;
      return { ...prev, agentCommands: rest };
    });
  };

  const addPath = () => {
    const trimmed = newPath.trim();
    if (!trimmed || !trimmed.startsWith("/")) return;
    if (settings.allowedExtraRoots.includes(trimmed)) {
      setNewPath("");
      return;
    }
    update((prev) => ({ ...prev, allowedExtraRoots: [...prev.allowedExtraRoots, trimmed] }));
    setNewPath("");
  };

  const removePath = (path: string) => {
    update((prev) => ({
      ...prev,
      allowedExtraRoots: prev.allowedExtraRoots.filter((p) => p !== path),
    }));
  };

  const agentRows: CodingAgentKind[] = ["claude", "codex", "terminal"];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-w-lg max-h-[85vh] flex-col border-border bg-popover text-foreground">
        <DialogHeader>
          <DialogTitle className="text-foreground">Coding settings</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Local-only — stored in this browser.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-1">

        {/* Git identity — read-only surface so the user can confirm
            "who am I committing as" before agents run gh on their behalf. */}
        <section className="space-y-1.5">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Git identity
          </h3>
          {identityState === "loading" && (
            <div className="text-[11.5px] text-muted-foreground">Loading…</div>
          )}
          {identityState === "error" && (
            <div className="text-[11.5px] text-rose-300/70">
              Failed to load identity — restart the server to pick up <code className="font-mono">/git-identity</code>.
            </div>
          )}
          {identityState === "ok" && identity && (
            <div className="space-y-1 rounded-md border border-border/70 bg-muted/20 p-2 text-[11.5px]">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">git user</span>
                <span className="truncate font-mono text-foreground">
                  {identity.git.name ?? "—"}
                  {identity.git.email && (
                    <span className="text-muted-foreground"> &lt;{identity.git.email}&gt;</span>
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">gh auth</span>
                {identity.gh ? (
                  <a
                    href={identity.gh.url ?? `https://github.com/${identity.gh.login}`}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate font-mono text-emerald-300/85 hover:text-emerald-200"
                  >
                    @{identity.gh.login}
                  </a>
                ) : (
                  <span className="font-mono text-rose-300/70">not signed in</span>
                )}
              </div>
            </div>
          )}
          <p className="text-[10.5px] text-muted-foreground/80">
            Configure with <code className="font-mono">git config --global user.name/email</code> and <code className="font-mono">gh auth login</code>.
          </p>
        </section>

        {/* Agent commands */}
        <section className="space-y-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Agent commands
          </h3>
          <p className="text-[11px] text-muted-foreground">
            Shell command launched when you start an agent session. Leave empty to use the server default.
          </p>
          <div className="space-y-2">
            {agentRows.map((kind) => {
              const fallback = capabilities?.agents[kind]?.command ?? "";
              const value = settings.agentCommands[kind] ?? "";
              const overridden = settings.agentCommands[kind] !== undefined;
              return (
                <div key={kind} className="grid grid-cols-[5rem_1fr_auto] items-center gap-2">
                  <label className="text-[12px] font-medium text-foreground/70">{AGENT_LABEL[kind]}</label>
                  <Input
                    value={value}
                    onChange={(e) => setCommand(kind, e.target.value)}
                    placeholder={fallback || "(unavailable)"}
                    className="h-8 border-border bg-muted/30 font-mono text-[12px] text-foreground"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!overridden}
                    onClick={() => resetCommand(kind)}
                    className="h-8 px-2 text-[10px] text-muted-foreground hover:text-foreground"
                    title="Reset to server default"
                  >
                    Reset
                  </Button>
                </div>
              );
            })}
          </div>
        </section>

        {/* PR command */}
        <section className="space-y-2 border-t border-border/70 pt-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            PR command
          </h3>
          <p className="text-[11px] text-muted-foreground">
            Run by the workspace "PR" button when the current branch has no open PR.
            Defaults to a non-interactive Claude prompt that pushes + opens a PR.
          </p>
          <Textarea
            value={settings.prCommand}
            onChange={(e) => update({ prCommand: e.target.value })}
            rows={3}
            placeholder={DEFAULT_PR_COMMAND}
            className="border-border bg-muted/30 font-mono text-[12px] text-foreground"
          />
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => update({ prCommand: DEFAULT_PR_COMMAND })}
              disabled={settings.prCommand === DEFAULT_PR_COMMAND}
              className="h-7 px-2 text-[10px] text-muted-foreground hover:text-foreground"
            >
              Reset to default
            </Button>
          </div>
        </section>

        {/* Workspace paths */}
        <section className="space-y-2 border-t border-border/70 pt-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Workspaces outside server root
              </h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Allow "Add workspace" to pick from paths beyond the server work dir.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.allowOutsideWorkspace}
              onClick={() => update({ allowOutsideWorkspace: !settings.allowOutsideWorkspace })}
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
                settings.allowOutsideWorkspace ? "bg-emerald-500/70" : "bg-muted",
              )}
            >
              <span
                className={cn(
                  "inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform",
                  settings.allowOutsideWorkspace ? "translate-x-[1.125rem]" : "translate-x-0.5",
                )}
              />
            </button>
          </div>

          {settings.allowOutsideWorkspace && (
            <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-2">
              <div className="text-[11px] text-muted-foreground">
                Whitelisted roots (absolute paths). These appear as alternative starting points in the picker.
              </div>
              <div className="space-y-1">
                {settings.allowedExtraRoots.length === 0 && (
                  <div className="text-[11px] italic text-muted-foreground/80">No paths added yet.</div>
                )}
                {settings.allowedExtraRoots.map((path) => (
                  <div key={path} className="flex items-center gap-1.5 rounded bg-muted/30 px-2 py-1">
                    <code className="flex-1 truncate font-mono text-[11.5px] text-foreground/80">{path}</code>
                    <button
                      type="button"
                      onClick={() => removePath(path)}
                      className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-rose-300"
                      title="Remove"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <form
                onSubmit={(e) => { e.preventDefault(); addPath(); }}
                className="flex items-center gap-1.5"
              >
                <Input
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  placeholder="/data/some-project"
                  className="h-7 flex-1 border-border bg-muted/30 font-mono text-[11.5px] text-foreground"
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={!newPath.trim().startsWith("/")}
                  className="h-7 gap-1 px-2 text-[11px]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add
                </Button>
              </form>
            </div>
          )}
        </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
