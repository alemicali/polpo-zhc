import { useEffect, useMemo, useState } from "react";
import { GitBranch, Loader2, TerminalSquare } from "lucide-react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { apiUrl } from "@/lib/config";
import { cn } from "@/lib/utils";
import type { CodingAgentKind, CodingCapabilities } from "./types";

type Props = {
  workspaceCwd: string;
  trigger: React.ReactNode;
  onCreate: (config: { agentKind: CodingAgentKind; cwdOverride?: string; branch?: string; label?: string }) => void;
};

type WorktreeMode = "same" | "new";

const AGENTS: { kind: CodingAgentKind; label: string; description: string; icon: React.ReactNode }[] = [
  {
    kind: "claude",
    label: "Claude",
    description: "Anthropic Claude Code CLI",
    icon: <Icon icon="logos:anthropic-icon" className="h-4 w-4" />,
  },
  {
    kind: "codex",
    label: "Codex",
    description: "OpenAI Codex CLI",
    icon: <Icon icon="logos:openai-icon" className="h-4 w-4" />,
  },
  {
    kind: "terminal",
    label: "Terminal",
    description: "Plain shell — bring your own tools",
    icon: <TerminalSquare className="h-4 w-4" />,
  },
];

export function NewTerminalDialog({ workspaceCwd, trigger, onCreate }: Props) {
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState<CodingAgentKind>("terminal");
  const [worktreeMode, setWorktreeMode] = useState<WorktreeMode>("same");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [capabilities, setCapabilities] = useState<CodingCapabilities | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch(apiUrl("/api/v1/coding/capabilities"), { credentials: "include" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ok) throw new Error(body?.error || `Capabilities failed (${res.status})`);
        return body.data as CodingCapabilities;
      })
      .then((data) => {
        if (!cancelled) setCapabilities(data);
      })
      .catch(() => {
        if (!cancelled) setCapabilities(null);
      });
    return () => { cancelled = true; };
  }, [open]);

  const availableAgents = useMemo(() => {
    if (!capabilities) return AGENTS.filter((a) => a.kind === "terminal");
    return AGENTS.filter((a) => capabilities.agents[a.kind]?.available);
  }, [capabilities]);

  useEffect(() => {
    if (!open) return;
    if (availableAgents.length === 0) return;
    if (!availableAgents.some((a) => a.kind === agent)) {
      setAgent(availableAgents[0].kind);
    }
  }, [agent, availableAgents, open]);

  const reset = () => {
    setAgent("terminal");
    setWorktreeMode("same");
    setBranch("");
    setBusy(false);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      let cwdOverride: string | undefined;
      let resolvedBranch: string | undefined;

      if (worktreeMode === "new") {
        const trimmed = branch.trim();
        if (!trimmed) {
          toast.error("Branch name required");
          setBusy(false);
          return;
        }
        const res = await fetch(apiUrl("/api/v1/git/worktree/create"), {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: workspaceCwd, branch: trimmed }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ok) {
          throw new Error(body?.error || `Worktree create failed (${res.status})`);
        }
        cwdOverride = body.data.path;
        resolvedBranch = body.data.branch;
      }

      onCreate({
        agentKind: agent,
        cwdOverride,
        branch: resolvedBranch,
        label: resolvedBranch ?? "",
      });
      setOpen(false);
      reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create session");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        className="w-80 p-0 border-white/[0.08] bg-[#141414] text-white/85"
      >
        {/* Header */}
        <div className="border-b border-white/[0.06] px-3 py-2 text-[10px] uppercase tracking-[0.14em] text-white/40">
          New session
        </div>

        {/* Agent picker */}
        <fieldset className="px-2 py-2">
          <legend className="px-1 text-[10px] font-semibold uppercase tracking-widest text-white/35">Agent</legend>
          <div className="mt-1 grid gap-1">
            {availableAgents.map((a) => (
              <button
                key={a.kind}
                type="button"
                onClick={() => setAgent(a.kind)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                  agent === a.kind ? "bg-white/[0.06] ring-1 ring-emerald-400/30" : "hover:bg-white/[0.03]",
                )}
              >
                <span className="flex h-6 w-6 items-center justify-center rounded text-white/85">{a.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-white/90">{a.label}</div>
                  <div className="text-[10px] text-white/40 truncate">{a.description}</div>
                </div>
                {agent === a.kind && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
              </button>
            ))}
            {capabilities && availableAgents.length < AGENTS.length && (
              <div className="px-2 py-1 text-[10px] leading-snug text-white/35">
                Claude/Codex appear only when their CLI is installed in the server image.
              </div>
            )}
          </div>
        </fieldset>

        {/* Worktree picker */}
        <fieldset className="border-t border-white/[0.06] px-2 py-2">
          <legend className="px-1 text-[10px] font-semibold uppercase tracking-widest text-white/35">Worktree</legend>
          <div className="mt-1 grid grid-cols-2 gap-1">
            <ChoicePill
              selected={worktreeMode === "same"}
              onClick={() => setWorktreeMode("same")}
              label="Same"
              detail="Use the workspace cwd"
            />
            <ChoicePill
              selected={worktreeMode === "new"}
              onClick={() => setWorktreeMode("new")}
              label="New"
              detail="Branch + worktree"
            />
          </div>
          {worktreeMode === "new" && (
            <div className="mt-2 flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1">
              <GitBranch className="h-3.5 w-3.5 text-white/40" />
              <Input
                autoFocus
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="feat/my-thing"
                className="h-5 min-w-0 flex-1 border-0 bg-transparent px-0.5 font-mono text-[11.5px] text-white/85 shadow-none focus-visible:ring-0"
              />
            </div>
          )}
        </fieldset>

        {/* Footer */}
        <div className="flex items-center justify-end gap-1.5 border-t border-white/[0.06] px-2 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            className="h-7 rounded-md px-2 text-[11px] text-white/55 hover:bg-white/[0.05] hover:text-white"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={busy || (worktreeMode === "new" && !branch.trim())}
            className="h-7 rounded-md px-3 text-[11px] font-medium"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Create
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ChoicePill({ selected, onClick, label, detail }: { selected: boolean; onClick: () => void; label: string; detail: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-2 py-1.5 text-left transition-colors",
        selected ? "bg-white/[0.06] ring-1 ring-emerald-400/30" : "hover:bg-white/[0.03]",
      )}
    >
      <div className="text-[12px] font-medium text-white/90">{label}</div>
      <div className="text-[10px] text-white/40 truncate">{detail}</div>
    </button>
  );
}
