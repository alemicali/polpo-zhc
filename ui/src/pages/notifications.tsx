import { useState, useMemo } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
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
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Bell,
  Send,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Info,
  Loader2,
  RefreshCw,
  Search,
  Clock,
  Hash,
  Megaphone,
  Zap,
  Filter,
  MailCheck,
  MailX,
  ArrowUpRight,
} from "lucide-react";
import { useNotifications } from "@openpolpo/react-sdk";
import type { NotificationRecord, NotificationSeverity } from "@openpolpo/react-sdk";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ── Severity styling ──

const severityConfig: Record<
  NotificationSeverity,
  { icon: React.ElementType; color: string; bg: string; ring: string; label: string }
> = {
  info: {
    icon: Info,
    color: "text-sky-400",
    bg: "bg-sky-500/10",
    ring: "ring-sky-500/20",
    label: "Info",
  },
  warning: {
    icon: AlertTriangle,
    color: "text-amber-400",
    bg: "bg-amber-500/10",
    ring: "ring-amber-500/20",
    label: "Warning",
  },
  critical: {
    icon: Zap,
    color: "text-rose-400",
    bg: "bg-rose-500/10",
    ring: "ring-rose-500/20",
    label: "Critical",
  },
};

const statusConfig: Record<
  string,
  { icon: React.ElementType; color: string; bg: string; label: string }
> = {
  sent: {
    icon: CheckCircle2,
    color: "text-emerald-400",
    bg: "bg-emerald-500/10",
    label: "Sent",
  },
  failed: {
    icon: XCircle,
    color: "text-red-400",
    bg: "bg-red-500/10",
    label: "Failed",
  },
};

// ── Stat card ──

function StatCard({
  label,
  value,
  icon: Icon,
  color,
  bg,
  subtitle,
}: {
  label: string;
  value: number;
  icon: React.ElementType;
  color: string;
  bg: string;
  subtitle?: string;
}) {
  return (
    <Card className="relative overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              {label}
            </p>
            <p className="text-2xl font-bold tracking-tight mt-1">{value}</p>
            {subtitle && (
              <p className="text-[10px] text-muted-foreground mt-0.5">{subtitle}</p>
            )}
          </div>
          <div className={cn("flex h-9 w-9 items-center justify-center rounded-lg", bg)}>
            <Icon className={cn("h-4 w-4", color)} />
          </div>
        </div>
      </CardContent>
      {/* Decorative accent bar */}
      <div className={cn("absolute bottom-0 left-0 right-0 h-0.5", bg.replace("/10", "/40"))} />
    </Card>
  );
}

// ── Notification row ──

function NotificationRow({ record }: { record: NotificationRecord }) {
  const sev = severityConfig[record.severity] ?? severityConfig.info;
  const SevIcon = sev.icon;
  const stat = statusConfig[record.status] ?? statusConfig.sent;
  const StatIcon = stat.icon;

  return (
    <div className="flex items-start gap-3 px-4 py-3 hover:bg-muted/20 transition-colors group">
      {/* Severity indicator */}
      <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5", sev.bg)}>
        <SevIcon className={cn("h-4 w-4", sev.color)} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">
            {record.title}
          </span>
          <Badge
            variant="outline"
            className={cn("text-[9px] px-1.5 py-0 shrink-0", sev.color)}
          >
            {sev.label}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
          {record.body}
        </p>
        <div className="flex items-center gap-3 mt-1.5 flex-wrap">
          <Badge variant="secondary" className="text-[9px] gap-1 px-1.5 py-0">
            <Hash className="h-2 w-2" />
            {record.channelType}
          </Badge>
          <span className="text-[10px] text-muted-foreground font-mono">
            {record.channel}
          </span>
          {record.sourceEvent && (
            <Badge variant="outline" className="text-[8px] font-mono px-1 py-0">
              {record.sourceEvent}
            </Badge>
          )}
          {record.attachmentCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary" className="text-[9px] gap-0.5 px-1.5 py-0 cursor-help">
                  <ArrowUpRight className="h-2 w-2" />
                  {record.attachmentCount} file{record.attachmentCount > 1 ? "s" : ""}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="text-xs">
                {record.attachmentTypes?.join(", ") ?? "Attached outcomes"}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Right side: status + time */}
      <div className="flex flex-col items-end gap-1.5 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={cn("flex items-center gap-1 rounded-md px-1.5 py-0.5", stat.bg)}>
              <StatIcon className={cn("h-3 w-3", stat.color)} />
              <span className={cn("text-[10px] font-medium", stat.color)}>{stat.label}</span>
            </div>
          </TooltipTrigger>
          {record.error && (
            <TooltipContent className="text-xs max-w-xs text-red-400">
              {record.error}
            </TooltipContent>
          )}
        </Tooltip>
        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
          <Clock className="h-2.5 w-2.5" />
          {formatDistanceToNow(new Date(record.timestamp), { addSuffix: true })}
        </span>
      </div>
    </div>
  );
}

// ── Send Direct dialog ──

function SendDirectDialog({
  onSend,
  sending,
}: {
  onSend: (req: { channel: string; title: string; body: string; severity?: NotificationSeverity; delayMs?: number }) => Promise<void>;
  sending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<NotificationSeverity>("info");
  const [delay, setDelay] = useState("");

  const reset = () => {
    setChannel("");
    setTitle("");
    setBody("");
    setSeverity("info");
    setDelay("");
  };

  const handleSend = async () => {
    if (!channel || !title || !body) return;
    const delayMs = delay ? parseInt(delay, 10) * 1000 : undefined;
    await onSend({ channel, title, body, severity, delayMs });
    reset();
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <Send className="h-3.5 w-3.5" />
          Send Direct
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Megaphone className="h-4 w-4 text-muted-foreground" />
            Send Direct Notification
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              Channel ID
            </label>
            <Input
              className="mt-1 h-8 text-sm font-mono"
              placeholder="e.g. telegram, slack-general"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              Title
            </label>
            <Input
              className="mt-1 h-8 text-sm"
              placeholder="Notification title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              Body
            </label>
            <Textarea
              className="mt-1 text-sm min-h-[80px] resize-none"
              placeholder="Notification body (HTML supported)"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Severity
              </label>
              <Select value={severity} onValueChange={(v) => setSeverity(v as NotificationSeverity)}>
                <SelectTrigger className="mt-1 h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Delay (seconds)
              </label>
              <Input
                className="mt-1 h-8 text-sm"
                type="number"
                min="0"
                placeholder="0"
                value={delay}
                onChange={(e) => setDelay(e.target.value)}
              />
            </div>
          </div>
          <Button
            className="w-full gap-2"
            onClick={handleSend}
            disabled={!channel || !title || !body || sending}
          >
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            {delay && parseInt(delay, 10) > 0
              ? `Schedule in ${delay}s`
              : "Send Now"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ──

export function NotificationsPage() {
  const { notifications, stats, sendNotification, refetch, loading } = useNotifications({ limit: 200 });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [sending, setSending] = useState(false);

  const handleSend = async (req: {
    channel: string;
    title: string;
    body: string;
    severity?: NotificationSeverity;
    delayMs?: number;
  }) => {
    setSending(true);
    try {
      const result = await sendNotification(req);
      const isScheduled = req.delayMs && req.delayMs > 0;
      toast.success(
        isScheduled
          ? `Notification scheduled (fires at ${new Date(result.firesAt).toLocaleTimeString()})`
          : "Notification sent"
      );
    } catch (e) {
      toast.error(`Send failed: ${(e as Error).message}`);
    } finally {
      setSending(false);
    }
  };

  // Filtered + searched notifications
  const filtered = useMemo(() => {
    return notifications.filter((n) => {
      if (statusFilter !== "all" && n.status !== statusFilter) return false;
      if (severityFilter !== "all" && n.severity !== severityFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          n.title.toLowerCase().includes(q) ||
          n.body.toLowerCase().includes(q) ||
          n.channel.toLowerCase().includes(q) ||
          n.channelType.toLowerCase().includes(q) ||
          n.sourceEvent.toLowerCase().includes(q) ||
          n.ruleName.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [notifications, search, statusFilter, severityFilter]);

  // Severity breakdown for current filtered set
  const severityCounts = useMemo(() => {
    const c = { info: 0, warning: 0, critical: 0 };
    for (const n of filtered) {
      if (n.severity in c) c[n.severity as keyof typeof c]++;
    }
    return c;
  }, [filtered]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* ── Stats row ── */}
      <div className="grid grid-cols-4 gap-3 shrink-0">
        <StatCard
          label="Total"
          value={stats?.total ?? 0}
          icon={Bell}
          color="text-sky-400"
          bg="bg-sky-500/10"
        />
        <StatCard
          label="Sent"
          value={stats?.sent ?? 0}
          icon={MailCheck}
          color="text-emerald-400"
          bg="bg-emerald-500/10"
          subtitle={stats && stats.total > 0 ? `${Math.round((stats.sent / stats.total) * 100)}% success` : undefined}
        />
        <StatCard
          label="Failed"
          value={stats?.failed ?? 0}
          icon={MailX}
          color="text-red-400"
          bg="bg-red-500/10"
          subtitle={stats && stats.failed > 0 ? "Check channel config" : undefined}
        />
        <StatCard
          label="Critical"
          value={severityCounts.critical}
          icon={Zap}
          color="text-rose-400"
          bg="bg-rose-500/10"
          subtitle={severityCounts.warning > 0 ? `+ ${severityCounts.warning} warnings` : undefined}
        />
      </div>

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search notifications..."
            className="pl-9 h-8 text-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Status filter */}
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 w-28 text-xs">
            <Filter className="h-3 w-3 mr-1.5 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All status</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>

        {/* Severity filter */}
        <Select value={severityFilter} onValueChange={setSeverityFilter}>
          <SelectTrigger className="h-8 w-28 text-xs">
            <AlertTriangle className="h-3 w-3 mr-1.5 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severity</SelectItem>
            <SelectItem value="info">Info</SelectItem>
            <SelectItem value="warning">Warning</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex-1" />

        <Badge variant="secondary" className="text-xs shrink-0">
          {filtered.length} notification{filtered.length !== 1 ? "s" : ""}
        </Badge>

        <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={refetch}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>

        <SendDirectDialog onSend={handleSend} sending={sending} />
      </div>

      {/* ── Notification list ── */}
      <Card className="flex-1 flex flex-col overflow-hidden">
        <CardHeader className="pb-0 pt-3 px-4 shrink-0">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm">History</CardTitle>
            {/* Inline severity breakdown */}
            <div className="flex items-center gap-3 ml-4">
              {(["info", "warning", "critical"] as const).map((sev) => {
                const count = severityCounts[sev];
                if (count === 0) return null;
                const cfg = severityConfig[sev];
                return (
                  <Tooltip key={sev}>
                    <TooltipTrigger asChild>
                      <div className="flex items-center gap-1 cursor-help">
                        <div className={cn("h-1.5 w-1.5 rounded-full", cfg.bg.replace("/10", ""))} style={{ backgroundColor: `var(--${sev === "info" ? "sky" : sev === "warning" ? "amber" : "rose"}-400, currentColor)` }} />
                        <span className="text-[10px] text-muted-foreground">{count}</span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent className="text-xs">{cfg.label}: {count}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex-1 overflow-hidden p-0 mt-2">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <Bell className="h-12 w-12 mb-4 opacity-30" />
              <p className="text-sm font-medium">
                {notifications.length === 0
                  ? "No notifications yet"
                  : "No matching notifications"}
              </p>
              <p className="text-xs mt-1 text-center max-w-xs">
                {notifications.length === 0
                  ? "Notifications appear when rules fire or you send directly"
                  : "Try adjusting your filters"}
              </p>
            </div>
          ) : (
            <ScrollArea className="h-full">
              <div className="divide-y divide-border/30">
                {filtered.map((n) => (
                  <NotificationRow key={n.id} record={n} />
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
