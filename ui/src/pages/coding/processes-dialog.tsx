import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCcw, Terminal as TerminalIcon, Code2, Square, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { apiUrl } from "@/lib/config";
import { cn } from "@/lib/utils";

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

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

export function ProcessesDialog({ open, onOpenChange }: Props) {
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
      <DialogContent className="max-w-3xl border-white/[0.08] bg-[#141414] text-white/85">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogTitle className="text-white/90">Server processes</DialogTitle>
              <DialogDescription className="text-white/45">
                {stats.terminals} terminal · {stats.codeServers} code-server · {stats.totalDescendants} descendants
                {capturedAt && <span className="ml-2 text-white/30">· refreshed {timeAgo(capturedAt)}</span>}
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
            <div className="rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-6 text-center text-[12px] text-white/40">
              {loading ? "Loading…" : "No managed processes."}
            </div>
          )}
          {items.map((item) => (
            <ProcessRow
              key={`${item.kind}-${item.id}`}
              item={item}
              onKill={() => void kill(item.kind, item.id)}
              killing={killing === `${item.kind}/${item.id}`}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProcessRow({ item, onKill, killing }: { item: ProcessItem; onKill: () => void; killing: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const descendants = countDescendants(item.tree);
  const hasTree = !!item.tree && item.tree.children.length > 0;

  return (
    <div className="rounded-md border border-white/[0.06] bg-white/[0.02]">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          disabled={!hasTree}
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-white/45 hover:bg-white/[0.06] hover:text-white disabled:opacity-30"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        {item.kind === "terminal" ? (
          <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-white/55" />
        ) : (
          <Code2 className="h-3.5 w-3.5 shrink-0 text-emerald-300/80" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[12px]">
            <span className="font-medium text-white/85">
              {item.kind === "terminal" ? agentLabel(item.agentKind) : `code-server :${item.port}`}
            </span>
            <span className="font-mono text-[10.5px] tabular-nums text-white/35">pid {item.pid ?? "—"}</span>
            {item.kind === "terminal" && item.clients > 0 && (
              <span className="rounded bg-emerald-500/10 px-1.5 py-px text-[10px] font-medium text-emerald-300">
                {item.clients} client{item.clients === 1 ? "" : "s"}
              </span>
            )}
            {descendants > 0 && (
              <span className="rounded bg-white/[0.05] px-1.5 py-px text-[10px] text-white/55">
                +{descendants} child{descendants === 1 ? "" : "ren"}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-white/45" title={item.cwd}>
            {item.cwd}
          </div>
          {item.kind === "terminal" && item.agentCommand && (
            <div className="mt-0.5 truncate font-mono text-[10.5px] text-white/35" title={item.agentCommand}>
              ⮕ {item.agentCommand}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end text-right text-[10px] text-white/35">
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
        <div className="border-t border-white/[0.04] px-2 py-1.5">
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
          <div className="flex items-baseline gap-2 truncate font-mono text-[11px] text-white/65">
            <span className="tabular-nums text-white/35">{child.pid}</span>
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
