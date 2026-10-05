import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCcw, Terminal as TerminalIcon, Code2, Square, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { apiUrl } from "@/lib/config";
import type { CodingTerminal, CodingWorkspace } from "./types";

type ProcessNode = {
  pid: number;
  ppid?: number;
  command: string;
  cmdline: string;
  children: ProcessNode[];
};

type TerminalItem = {
  kind: "terminal";
  id: string;
  pid: number;
  cwd: string;
  agentKind: "terminal" | "claude" | "codex";
  agentCommand?: string;
  startedAt: string;
  clients: number;
  tree: ProcessNode | null;
};

type CodeServerItem = {
  kind: "code-server";
  id: string;
  pid: number | null;
  cwd: string;
  port: number;
  startedAt: string;
  running: boolean;
  tree: ProcessNode | null;
};

type ProcessItem = TerminalItem | CodeServerItem;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Used to resolve `process.id` → human label/workspace for each row. */
  terminals: CodingTerminal[];
  workspaces: CodingWorkspace[];
};

export function ProcessesDialog({ open, onOpenChange, terminals, workspaces }: Props) {
  const terminalById = useMemo(() => new Map(terminals.map((t) => [t.id, t])), [terminals]);
  const workspaceById = useMemo(() => new Map(workspaces.map((w) => [w.id, w])), [workspaces]);
  const [items, setItems] = useState<ProcessItem[]>([]);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [killing, setKilling] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/v1/coding/processes"), { credentials: "include" });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) {
        setItems(body.data.items ?? []);
        setCapturedAt(body.data.capturedAt ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    const id = window.setInterval(() => void load(), 4_000);
    return () => window.clearInterval(id);
  }, [open, load]);

  const kill = async (kind: ProcessItem["kind"], id: string) => {
    setKilling(`${kind}/${id}`);
    try {
      await fetch(apiUrl(`/api/v1/coding/processes/${kind}/${encodeURIComponent(id)}`), {
        method: "DELETE",
        credentials: "include",
      });
      await load();
    } finally {
      setKilling(null);
    }
  };

  const stats = useMemo(() => {
    const terminals = items.filter((i) => i.kind === "terminal").length;
    const codeServers = items.filter((i) => i.kind === "code-server").length;
    const totalDescendants = items.reduce((sum, i) => sum + countDescendants(i.tree), 0);
    return { terminals, codeServers, totalDescendants };
  }, [items]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[min(96vw,1100px)] w-[min(96vw,1100px)] border-border bg-popover text-foreground">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogTitle className="text-foreground">Server processes</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {stats.terminals} terminal · {stats.codeServers} code-server · {stats.totalDescendants} descendants
                {capturedAt && <span className="ml-2 text-muted-foreground/70">· refreshed {timeAgo(capturedAt)}</span>}
              </DialogDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
              className="h-7 gap-1.5 px-2 text-[11px]"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          {items.length === 0 && (
            <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-6 text-center text-[12px] text-muted-foreground">
              {loading ? "Loading…" : "No managed processes."}
            </div>
          )}
          {items.map((item) => {
            // Resolve owning session (and its workspace) by id for terminal
            // kind; code-server rows fall back to workspace lookup by cwd.
            const term = item.kind === "terminal" ? terminalById.get(item.id) : undefined;
            const ws = term
              ? workspaceById.get(term.workspaceId)
              : workspaces.find((w) => w.cwd === item.cwd);
            return (
              <ProcessRow
                key={`${item.kind}-${item.id}`}
                item={item}
                sessionLabel={term?.label || undefined}
                workspaceName={ws?.name}
                workspaceCwd={ws?.cwd}
                onKill={() => void kill(item.kind, item.id)}
                killing={killing === `${item.kind}/${item.id}`}
              />
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProcessRow({
  item,
  sessionLabel,
  workspaceName,
  workspaceCwd,
  onKill,
  killing,
}: {
  item: ProcessItem;
  sessionLabel?: string;
  workspaceName?: string;
  workspaceCwd?: string;
  onKill: () => void;
  killing: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const descendants = countDescendants(item.tree);
  const hasTree = !!item.tree && item.tree.children.length > 0;

  return (
    <div className="rounded-md border border-border/70 bg-muted/20">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          disabled={!hasTree}
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        {item.kind === "terminal" ? (
          <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Code2 className="h-3.5 w-3.5 shrink-0 text-emerald-300/80" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
            <span className="font-medium text-foreground">
              {sessionLabel || (item.kind === "terminal" ? agentLabel(item.agentKind) : `code-server :${item.port}`)}
            </span>
            {sessionLabel && item.kind === "terminal" && (
              <span className="text-[11px] text-muted-foreground">{agentLabel(item.agentKind)}</span>
            )}
            {workspaceName && (
              <span className="rounded bg-muted/40 px-1.5 py-px text-[10px] text-muted-foreground" title={workspaceCwd}>
                {workspaceName}
              </span>
            )}
            <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground/80">pid {item.pid ?? "—"}</span>
            {item.kind === "terminal" && item.clients > 0 && (
              <span className="rounded bg-emerald-500/10 px-1.5 py-px text-[10px] font-medium text-emerald-300">
                {item.clients} client{item.clients === 1 ? "" : "s"}
              </span>
            )}
            {descendants > 0 && (
              <span className="rounded bg-muted/50 px-1.5 py-px text-[10px] text-muted-foreground">
                +{descendants} child{descendants === 1 ? "" : "ren"}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={item.cwd}>
            {item.cwd}
          </div>
          {item.kind === "terminal" && item.agentCommand && (
            <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground/80" title={item.agentCommand}>
              ⮕ {item.agentCommand}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end text-right text-[10px] text-muted-foreground/80">
          <span className="tabular-nums">{timeAgo(item.startedAt)}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={killing}
            onClick={onKill}
            className="mt-1 h-6 gap-1 rounded px-1.5 text-[10px] font-medium text-rose-300/80 hover:bg-rose-500/10 hover:text-rose-200"
          >
            {killing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
            Kill
          </Button>
        </div>
      </div>
      {expanded && item.tree && (
        <div className="border-t border-border/50 px-2 py-1.5">
          <ProcessTree node={item.tree} depth={0} />
        </div>
      )}
    </div>
  );
}

function ProcessTree({ node, depth }: { node: ProcessNode; depth: number }) {
  return (
    <div>
      {node.children.map((child) => (
        <div key={child.pid} className="leading-tight" style={{ paddingLeft: depth * 12 }}>
          <div className="flex items-baseline gap-2 truncate font-mono text-[11px] text-foreground/65">
            <span className="tabular-nums text-muted-foreground/80">{child.pid}</span>
            <span className="truncate" title={child.cmdline || child.command}>
              {child.cmdline || child.command || "?"}
            </span>
          </div>
          {child.children.length > 0 && <ProcessTree node={child} depth={depth + 1} />}
        </div>
      ))}
    </div>
  );
}

function agentLabel(kind: "terminal" | "claude" | "codex"): string {
  if (kind === "claude") return "Claude session";
  if (kind === "codex") return "Codex session";
  return "Terminal session";
}

function countDescendants(node: ProcessNode | null): number {
  if (!node) return 0;
  let total = node.children.length;
  for (const c of node.children) total += countDescendants(c);
  return total;
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
