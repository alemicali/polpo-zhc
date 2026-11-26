import { Terminal as TerminalIcon } from "lucide-react";
import { Icon } from "@iconify/react";
import { ensureLogosPack } from "@/lib/iconify-bootstrap";
import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/shared/eyebrow";

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
  ensureLogosPack();
  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-background text-foreground">
      <div className="relative z-10 mx-auto flex w-full max-w-[640px] flex-col items-center px-6 py-10">
        {/* Header */}
        <div className="mb-8 flex flex-col items-center gap-2">
          <Eyebrow>New workspace</Eyebrow>
          <h1 className="mt-1 text-center font-heading text-h1 text-foreground">
            How do you want to start?
          </h1>
          <p className="mt-1 max-w-md text-center text-small leading-relaxed text-muted-foreground">
            A fresh git worktree is ready. Start Claude Code or Codex as a chat (they edit and run commands here; risky actions ask you first), or a plain terminal — you can open more sessions in this
            workspace at any time.
          </p>
          <div className="mt-3 flex items-center gap-1.5 rounded-pill border border-border bg-muted/30 px-2.5 py-1 font-mono text-caption text-muted-foreground">
            <span className="text-muted-foreground">{projectName}</span>
            <span className="text-muted-foreground/50">/</span>
            <span className="text-success/85">{branch}</span>
          </div>
        </div>

        {/* Agent cards */}
        <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3">
          <AgentCard
            kind="claude"
            label="Claude"
            description="Claude Code as a chat, on your own account"
            tint="bg-chart-2/[0.06] hover:bg-chart-2/[0.10] border-chart-2/15 hover:border-chart-2/35"
            icon={<img src="/claude-favicon.svg" alt="Claude" className="h-5 w-5" />}
            onStart={onStart}
          />
          <AgentCard
            kind="codex"
            label="Codex"
            description="Codex as a chat, on your own account"
            tint="bg-chart-3/[0.05] hover:bg-chart-3/[0.10] border-chart-3/15 hover:border-chart-3/35"
            icon={<Icon icon="logos:openai-icon" className="h-5 w-5 dark:invert" />}
            onStart={onStart}
          />
          <AgentCard
            kind="terminal"
            label="Terminal"
            description="Plain shell"
            tint="bg-muted/20 hover:bg-muted border-border hover:border-foreground/20"
            icon={<TerminalIcon className="h-5 w-5 text-foreground/65" />}
            onStart={onStart}
          />
        </div>

        {/* Footer hint */}
        <div className="mt-6 truncate font-mono text-micro text-muted-foreground/70" title={cwd}>
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
        "hover:-translate-y-px hover:shadow-raised",
        tint,
      )}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-md bg-muted ring-1 ring-border">
        {icon}
      </span>
      <div className="mt-1 text-body font-medium tracking-tight text-foreground">{label}</div>
      <div className="text-caption leading-relaxed text-muted-foreground">{description}</div>
      <div className="mt-1 inline-flex items-center gap-1 text-label text-muted-foreground/70 transition-colors group-hover/card:text-primary">
        Start →
      </div>
    </button>
  );
}
