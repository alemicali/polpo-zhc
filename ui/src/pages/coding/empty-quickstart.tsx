import { Terminal as TerminalIcon } from "lucide-react";
import { Icon } from "@iconify/react";
import { ensureLogosPack } from "@/lib/iconify-bootstrap";
import { useEffect } from "react";
import { cn } from "@/lib/utils";

type AgentKind = "claude" | "codex" | "terminal";

type Props = {
  branch: string;
  projectName: string;
  cwd: string;
  onStart: (kind: AgentKind) => void;
};

/**
 * Empty-workspace landing screen — shown when "Add workspace" just created
 * a worktree on disk and there's no session in it yet. Three large agent
 * cards let the user spawn the first session in one click.
 *
 * Mood: dark, refined, deliberately quiet. The subtle radial wash + grid
 * scaffolding give it presence without yelling. Mono for git facts (branch,
 * cwd) and a higher-grade body for the prose lines.
 */
export function EmptyWorkspaceQuickStart({ branch, projectName, cwd, onStart }: Props) {
  useEffect(() => { ensureLogosPack(); }, []);
  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-[#0a0a0a] text-white/85">
      {/* Atmosphere — radial wash + faint grid */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 30%, rgba(52, 211, 153, 0.06) 0%, transparent 60%), radial-gradient(ellipse at 50% 80%, rgba(56, 189, 248, 0.03) 0%, transparent 50%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)",
          backgroundSize: "32px 32px",
          maskImage: "radial-gradient(ellipse at center, black 30%, transparent 80%)",
          WebkitMaskImage: "radial-gradient(ellipse at center, black 30%, transparent 80%)",
        }}
      />

      <div className="relative z-10 mx-auto flex w-full max-w-[640px] flex-col items-center px-6 py-10">
        {/* Header */}
        <div className="mb-8 flex flex-col items-center gap-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-emerald-400/80">
            New workspace
          </div>
          <h1 className="mt-1 text-center text-[26px] font-light leading-tight tracking-tight text-white">
            How do you want to start?
          </h1>
          <p className="mt-1 max-w-md text-center text-[12px] leading-relaxed text-white/45">
            A fresh git worktree is ready. Pick the agent — you can open more sessions in this
            workspace at any time.
          </p>
          <div className="mt-3 flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 font-mono text-[10.5px] text-white/55">
            <span className="text-white/40">{projectName}</span>
            <span className="text-white/20">/</span>
            <span className="text-emerald-300/85">{branch}</span>
          </div>
        </div>

        {/* Agent cards */}
        <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3">
          <AgentCard
            kind="claude"
            label="Claude"
            description="Anthropic Claude Code"
            tint="bg-orange-400/[0.06] hover:bg-orange-400/[0.10] border-orange-400/15 hover:border-orange-400/35"
            icon={<img src="/claude-favicon.svg" alt="Claude" className="h-5 w-5" />}
            onStart={onStart}
          />
          <AgentCard
            kind="codex"
            label="Codex"
            description="OpenAI Codex"
            tint="bg-emerald-400/[0.05] hover:bg-emerald-400/[0.10] border-emerald-400/15 hover:border-emerald-400/35"
            icon={<Icon icon="logos:openai-icon" className="h-5 w-5 invert" />}
            onStart={onStart}
          />
          <AgentCard
            kind="terminal"
            label="Terminal"
            description="Plain shell"
            tint="bg-white/[0.02] hover:bg-white/[0.06] border-white/[0.08] hover:border-white/[0.18]"
            icon={<TerminalIcon className="h-5 w-5 text-white/65" />}
            onStart={onStart}
          />
        </div>

        {/* Footer hint */}
        <div className="mt-6 truncate font-mono text-[10px] text-white/30" title={cwd}>
          {cwd}
        </div>
      </div>
    </div>
  );
}

function AgentCard({
  kind,
  label,
  description,
  icon,
  tint,
  onStart,
}: {
  kind: AgentKind;
  label: string;
  description: string;
  icon: React.ReactNode;
  tint: string;
  onStart: (k: AgentKind) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onStart(kind)}
      className={cn(
        "group/card relative flex flex-col items-start gap-2 rounded-md border px-3.5 py-3.5 text-left transition-all",
        "hover:-translate-y-px hover:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.6)]",
        tint,
      )}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-md bg-black/40 ring-1 ring-white/[0.08]">
        {icon}
      </span>
      <div className="mt-1 text-[13.5px] font-medium tracking-tight text-white/95">{label}</div>
      <div className="text-[10.5px] leading-relaxed text-white/45">{description}</div>
      <div className="mt-1 inline-flex items-center gap-1 text-[9.5px] font-medium uppercase tracking-[0.14em] text-white/30 transition-colors group-hover/card:text-emerald-300/80">
        Start →
      </div>
    </button>
  );
}
