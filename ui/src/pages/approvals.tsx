import { useState, useMemo } from "react";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  Search,
  Timer,
  User,
  FileText,
  MessageSquare,
  ThumbsUp,
  ThumbsDown,
} from "lucide-react";
import { useApprovals } from "@openpolpo/react-sdk";
import type { ApprovalRequest, ApprovalStatus } from "@openpolpo/react-sdk";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ── Status styling ──

const approvalStatusConfig: Record<
  ApprovalStatus,
  { icon: React.ElementType; color: string; bg: string; label: string; ring: string }
> = {
  pending: {
    icon: Clock,
    color: "text-amber-400",
    bg: "bg-amber-500/10",
    label: "Pending",
    ring: "ring-amber-500/30",
  },
  approved: {
    icon: CheckCircle2,
    color: "text-emerald-400",
    bg: "bg-emerald-500/10",
    label: "Approved",
    ring: "ring-emerald-500/30",
  },
  rejected: {
    icon: XCircle,
    color: "text-red-400",
    bg: "bg-red-500/10",
    label: "Rejected",
    ring: "ring-red-500/30",
  },
  timeout: {
    icon: Timer,
    color: "text-zinc-400",
    bg: "bg-zinc-500/10",
    label: "Timed Out",
    ring: "ring-zinc-500/30",
  },
};

// ── Stat card ──

function StatCard({
  label,
  value,
  icon: Icon,
  color,
  bg,
  accent,
}: {
  label: string;
  value: number;
  icon: React.ElementType;
  color: string;
  bg: string;
  accent?: boolean;
}) {
  return (
    <Card className={cn(
      "relative overflow-hidden transition-all",
      accent && value > 0 && "ring-1 ring-amber-500/30 shadow-amber-500/5 shadow-lg"
    )}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              {label}
            </p>
            <p className={cn("text-2xl font-bold tracking-tight mt-1", accent && value > 0 && "text-amber-400")}>
              {value}
            </p>
          </div>
          <div className={cn("flex h-9 w-9 items-center justify-center rounded-lg", bg)}>
            <Icon className={cn("h-4 w-4", color)} />
          </div>
        </div>
      </CardContent>
      <div className={cn("absolute bottom-0 left-0 right-0 h-0.5", bg.replace("/10", "/40"))} />
    </Card>
  );
}

// ── Approval action dialog ──

function RejectDialog({
  open,
  onOpenChange,
  onConfirm,
  submitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (feedback: string) => void;
  submitting: boolean;
}) {
  const [feedback, setFeedback] = useState("");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ShieldX className="h-4 w-4 text-red-400" />
            Reject Approval Request
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              Feedback (required)
            </label>
            <Textarea
              className="mt-1 text-sm min-h-[100px] resize-none"
              placeholder="Explain why this request is being rejected..."
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              autoFocus
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                onConfirm(feedback);
                setFeedback("");
              }}
              disabled={!feedback.trim() || submitting}
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ThumbsDown className="h-3.5 w-3.5" />
              )}
              Reject
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Approval card ──

function ApprovalCard({
  request,
  onApprove,
  onReject,
}: {
  request: ApprovalRequest;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const cfg = approvalStatusConfig[request.status];
  const StatusIcon = cfg.icon;
  const isPending = request.status === "pending";

  return (
    <Card className={cn(
      "transition-all",
      isPending && "ring-1 ring-amber-500/20 shadow-sm",
    )}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          {/* Status badge */}
          <div className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            cfg.bg,
            isPending && "animate-pulse"
          )}>
            <StatusIcon className={cn("h-5 w-5", cfg.color)} />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold">{request.gateName}</span>
              <Badge
                variant="outline"
                className={cn("text-[9px] px-1.5 py-0", cfg.color)}
              >
                {cfg.label}
              </Badge>
              {request.gateId !== request.gateName && (
                <span className="text-[10px] font-mono text-muted-foreground">
                  {request.gateId}
                </span>
              )}
            </div>

            {/* Metadata row */}
            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
              {request.taskId && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="secondary" className="text-[9px] gap-1 px-1.5 py-0 cursor-help">
                      <FileText className="h-2 w-2" />
                      Task {request.taskId.slice(0, 8)}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs font-mono">{request.taskId}</TooltipContent>
                </Tooltip>
              )}
              {request.planId && (
                <Badge variant="secondary" className="text-[9px] gap-1 px-1.5 py-0">
                  Plan {request.planId.slice(0, 8)}
                </Badge>
              )}
              <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                <Clock className="h-2.5 w-2.5" />
                Requested {formatDistanceToNow(new Date(request.requestedAt), { addSuffix: true })}
              </span>
            </div>

            {/* Resolution info */}
            {!!request.resolvedAt && (
              <div className="flex items-center gap-3 mt-1 flex-wrap">
                {request.resolvedBy && (
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <User className="h-2.5 w-2.5" />
                    {request.resolvedBy}
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground">
                  Resolved {formatDistanceToNow(new Date(request.resolvedAt), { addSuffix: true })}
                </span>
              </div>
            )}

            {/* Note */}
            {request.note && (
              <div className="flex items-start gap-1.5 mt-2 bg-muted/30 rounded-md px-2.5 py-2">
                <MessageSquare className="h-3 w-3 text-muted-foreground mt-0.5 shrink-0" />
                <p className="text-xs text-muted-foreground">{request.note}</p>
              </div>
            )}

            {/* Payload preview */}
            {request.payload != null && (
              <details className="mt-2 group/payload">
                <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                  View payload
                </summary>
                <pre className="text-[9px] bg-muted/40 rounded-md p-2 mt-1 whitespace-pre-wrap font-mono overflow-x-auto text-muted-foreground max-h-40 overflow-y-auto">
                  {JSON.stringify(request.payload, null, 2) as string}
                </pre>
              </details>
            )}
          </div>

          {/* Actions (pending only) */}
          {isPending && (
            <div className="flex flex-col gap-1.5 shrink-0">
              <Button
                size="sm"
                className="h-8 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                onClick={() => onApprove(request.id)}
              >
                <ThumbsUp className="h-3.5 w-3.5" />
                Approve
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-red-400 border-red-500/30 hover:bg-red-500/10 hover:text-red-300"
                onClick={() => onReject(request.id)}
              >
                <ThumbsDown className="h-3.5 w-3.5" />
                Reject
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main page ──

export function ApprovalsPage() {
  const { approvals, pending, approve, reject, refetch, loading } = useApprovals();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"pending" | "all" | "approved" | "rejected">("pending");
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleApprove = async (id: string) => {
    setSubmitting(true);
    try {
      await approve(id, { resolvedBy: "ui-operator" });
      toast.success("Request approved");
    } catch (e) {
      toast.error(`Approval failed: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async (feedback: string) => {
    if (!rejectTarget) return;
    setSubmitting(true);
    try {
      await reject(rejectTarget, feedback, "ui-operator");
      toast.success("Request rejected");
      setRejectTarget(null);
    } catch (e) {
      toast.error(`Rejection failed: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  // Filtered list
  const filtered = useMemo(() => {
    let list = approvals;
    if (tab === "pending") list = list.filter((a) => a.status === "pending");
    else if (tab === "approved") list = list.filter((a) => a.status === "approved");
    else if (tab === "rejected") list = list.filter((a) => a.status === "rejected" || a.status === "timeout");

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (a) =>
          a.gateName.toLowerCase().includes(q) ||
          a.gateId.toLowerCase().includes(q) ||
          (a.taskId ?? "").toLowerCase().includes(q) ||
          (a.planId ?? "").toLowerCase().includes(q) ||
          (a.note ?? "").toLowerCase().includes(q) ||
          (a.resolvedBy ?? "").toLowerCase().includes(q)
      );
    }

    return list.sort(
      (a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime()
    );
  }, [approvals, tab, search]);

  // Counts for tabs
  const counts = useMemo(() => ({
    pending: approvals.filter((a) => a.status === "pending").length,
    approved: approvals.filter((a) => a.status === "approved").length,
    rejected: approvals.filter((a) => a.status === "rejected" || a.status === "timeout").length,
    all: approvals.length,
  }), [approvals]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const tabs = [
    { value: "pending" as const, label: "Pending", count: counts.pending, accent: true },
    { value: "all" as const, label: "All", count: counts.all },
    { value: "approved" as const, label: "Approved", count: counts.approved },
    { value: "rejected" as const, label: "Rejected", count: counts.rejected },
  ];

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* ── Stats row ── */}
      <div className="grid grid-cols-4 gap-3 shrink-0">
        <StatCard
          label="Awaiting Review"
          value={counts.pending}
          icon={ShieldAlert}
          color="text-amber-400"
          bg="bg-amber-500/10"
          accent
        />
        <StatCard
          label="Total Requests"
          value={counts.all}
          icon={ShieldCheck}
          color="text-sky-400"
          bg="bg-sky-500/10"
        />
        <StatCard
          label="Approved"
          value={counts.approved}
          icon={CheckCircle2}
          color="text-emerald-400"
          bg="bg-emerald-500/10"
        />
        <StatCard
          label="Rejected / Timed Out"
          value={counts.rejected}
          icon={XCircle}
          color="text-red-400"
          bg="bg-red-500/10"
        />
      </div>

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-3 shrink-0">
        {/* Tab buttons */}
        <div className="flex items-center gap-1">
          {tabs.map((t) => (
            <Button
              key={t.value}
              variant={tab === t.value ? "default" : "ghost"}
              size="sm"
              className={cn(
                "h-7 text-xs gap-1.5",
                t.accent && tab !== t.value && counts.pending > 0 && "text-amber-400"
              )}
              onClick={() => setTab(t.value)}
            >
              {t.label}
              <Badge
                variant="secondary"
                className={cn(
                  "text-[9px]",
                  t.accent && counts.pending > 0 && tab !== t.value && "bg-amber-500/20 text-amber-400"
                )}
              >
                {t.count}
              </Badge>
            </Button>
          ))}
        </div>

        <div className="flex-1" />

        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search approvals..."
            className="pl-9 h-8 text-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={refetch}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* ── Pending highlight banner ── */}
      {pending.length > 0 && tab !== "pending" && (
        <div
          className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 cursor-pointer hover:bg-amber-500/10 transition-colors shrink-0"
          onClick={() => setTab("pending")}
        >
          <ShieldAlert className="h-4 w-4 text-amber-400 shrink-0" />
          <span className="text-xs font-medium text-amber-400">
            {pending.length} approval{pending.length !== 1 ? "s" : ""} awaiting review
          </span>
          <span className="text-[10px] text-muted-foreground ml-auto">Click to view</span>
        </div>
      )}

      {/* ── Approval list ── */}
      {filtered.length === 0 ? (
        <Card className="flex-1">
          <CardContent className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <ShieldCheck className="h-12 w-12 mb-4 opacity-30" />
            <p className="text-sm font-medium">
              {approvals.length === 0
                ? "No approval requests yet"
                : tab === "pending"
                  ? "No pending approvals"
                  : "No matching approvals"}
            </p>
            <p className="text-xs mt-1 text-center max-w-xs">
              {approvals.length === 0
                ? "Approval gates pause task execution until a human reviewer acts"
                : "Try switching tabs or adjusting your search"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-2 pr-4">
            {filtered.map((req) => (
              <ApprovalCard
                key={req.id}
                request={req}
                onApprove={handleApprove}
                onReject={(id) => setRejectTarget(id)}
              />
            ))}
          </div>
        </ScrollArea>
      )}

      {/* ── Reject dialog ── */}
      <RejectDialog
        open={rejectTarget !== null}
        onOpenChange={(open) => { if (!open) setRejectTarget(null); }}
        onConfirm={handleReject}
        submitting={submitting}
      />
    </div>
  );
}
