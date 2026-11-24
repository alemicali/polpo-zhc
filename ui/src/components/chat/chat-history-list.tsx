/**
 * The chat history — one component for every place it shows: the drill-in sidebar's Chat
 * level, the chat page's thread column (classic layout and the mobile overlay) and the compact
 * chat. Clean like the claude.ai sidebar: everything flat on the surface it sits on (no card, no
 * border box), separated only by spacing and small muted labels.
 *
 *   New chat            (+ a small menu: new chat with an agent, new group)
 *   Search              (title or agent; "/" while the history has focus)
 *   Pinned              (the thread's `starred` flag)
 *   Groups              (multi-agent rooms; hidden when there are none)
 *   Recents ⇅           By chat: Today, Yesterday, Previous 7 days, Previous 30 days, months
 *                       By agent: one collapsible section per agent, the orchestrator first
 *
 * Rows: one line; on hover or focus a ⋯ menu (Pin/Unpin, Rename, Delete with confirm), the same
 * actions on right-click. Keyboard: ↑/↓ (Home/End) move between rows, Enter opens, Delete asks
 * to delete, "/" goes to the search. No global shortcut: Ctrl/⌘+K belongs to the dashboard's
 * search.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  ArrowDownUp,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Search,
  SquarePen,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import { useAgents } from "@polpo-ai/react";
import type { AgentConfig } from "@polpo-ai/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { useOrchestratorName } from "@/lib/orchestrator-name";
import { cn } from "@/lib/utils";
import {
  ORCHESTRATOR_KEY,
  agentKeyOf,
  filterSessions,
  groupByAgent,
  groupByDate,
  pinnedOf,
  unpinnedOf,
  type HistorySession,
} from "@/lib/chat-history";
import {
  setChatHistoryOrganize,
  useChatHistoryOrganize,
  type ChatHistoryOrganize,
} from "@/hooks/use-chat-history-organize";
import { NewChatMenu } from "@/components/groups/new-chat-menu";
import { ORCHESTRATOR_MEMBER_ID } from "@/lib/rooms-api";
import { historyStyles, type HistoryStyles, type HistorySurface } from "./history-styles";

/** Rows rendered at first in "By chat"; scrolling to the end renders the next page. */
export const HISTORY_PAGE_SIZE = 50;
/** Chats shown per agent before "Show N more" (the open one always stays visible). */
const AGENT_PREVIEW = 5;

export interface ChatHistoryListProps {
  sessions: HistorySession[];
  activeSessionId: string | null;
  /** Threads receiving a reply right now (a dot on the row). */
  streamingSessionIds: readonly string[];
  onSelect: (id: string) => void;
  /** A new chat, with an agent when given (none: the orchestrator). */
  onNew: (agent?: string) => void;
  /** The New group dialog, preselecting the agent when given. */
  onNewGroup: (agent?: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, currentTitle: string) => void;
  /** Pin or unpin (the API's `starred`). */
  onTogglePin: (id: string, pinned: boolean) => void;
  /** The Groups section, given the search (GroupSidebarSection). */
  renderGroups?: (query: string) => ReactNode;
  surface: HistorySurface;
  /** A close control next to New chat (the chat page's column). */
  onClose?: () => void;
  /** Classes for the close control (e.g. only below lg). */
  closeClassName?: string;
  /** The clock for the time buckets (tests). */
  now?: Date;
}

/** An agent's avatar in a row: decorative (the row names the agent), out of the accessible name. */
function RowAvatar(props: ComponentProps<typeof AgentAvatar>) {
  return (
    <span aria-hidden className="flex shrink-0">
      <AgentAvatar {...props} />
    </span>
  );
}

function OrchestratorMark({ className }: { className?: string }) {
  return <span aria-hidden className={cn("flex shrink-0 items-center justify-center leading-none", className)}>🐙</span>;
}

// ── a chat row ──

function SessionRow({
  session,
  active,
  streaming,
  agent,
  agentName,
  showAgent,
  styles,
  onSelect,
  onRename,
  onTogglePin,
  onAskDelete,
}: {
  session: HistorySession;
  active: boolean;
  streaming: boolean;
  agent?: AgentConfig;
  agentName: string;
  showAgent: boolean;
  styles: HistoryStyles;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onAskDelete: (session: HistorySession) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pinned = !!session.starred;
  const title = session.title || "Untitled";
  const rename = () => onRename(session.id, title);
  const togglePin = () => onTogglePin(session.id, !pinned);
  const askDelete = () => onAskDelete(session);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="group/row relative" data-session-row={session.id}>
          <button
            type="button"
            data-history-row
            data-session-id={session.id}
            aria-current={active ? "page" : undefined}
            title={showAgent ? `${title} · ${agentName}` : title}
            onClick={() => onSelect(session.id)}
            className={cn(styles.row, "pr-8", active ? styles.rowActive : styles.rowIdle)}
          >
            {showAgent && (
              session.agent
                ? (
                  <RowAvatar
                    avatar={agent?.identity?.avatar}
                    name={agentName}
                    color={agent?.identity?.color}
                    size="xs"
                    className="size-4"
                    fallbackVariant="circle"
                    shape="circle"
                  />
                )
                : <OrchestratorMark className="size-4 text-micro" />
            )}
            {session.parentSessionId && (
              <GitBranch className="h-3 w-3 shrink-0 opacity-60" aria-label="Branch" />
            )}
            <span className="min-w-0 flex-1 truncate">{title}</span>
          </button>
          {streaming && (
            <span
              aria-label="Running"
              role="status"
              className={cn(
                "pointer-events-none absolute right-3 top-1/2 flex h-2 w-2 -translate-y-1/2 transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-0",
                menuOpen && "opacity-0",
              )}
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-pill bg-primary opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-pill bg-primary" />
            </span>
          )}
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Chat actions"
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  "absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md outline-none transition-opacity focus-visible:opacity-100",
                  styles.iconButton,
                  menuOpen ? "opacity-100" : "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100",
                )}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onSelect={togglePin} className="gap-2">
                {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                {pinned ? "Unpin" : "Pin"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={rename} className="gap-2">
                <Pencil className="h-3.5 w-3.5" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={askDelete} className="gap-2 text-destructive focus:text-destructive">
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem onSelect={togglePin} className="gap-2">
          {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          {pinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={rename} className="gap-2">
          <Pencil className="h-3.5 w-3.5" />
          Rename
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={askDelete} className="gap-2 text-destructive focus:text-destructive">
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function SectionLabel({ children, styles, sticky, action }: {
  children: ReactNode;
  styles: HistoryStyles;
  sticky?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className={cn(
      "flex items-center gap-1 px-3 pb-1 pt-3",
      sticky && cn("sticky top-0 z-10", styles.stickyBg),
    )}>
      <span className={cn("min-w-0 flex-1 truncate", styles.label)}>{children}</span>
      {action}
    </div>
  );
}

function OrganizeMenu({ value, styles }: { value: ChatHistoryOrganize; styles: HistoryStyles }) {
  const options: Array<[ChatHistoryOrganize, string]> = [["chat", "By chat"], ["agent", "By agent"]];
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Organize chats"
              className={cn("inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md", styles.iconButton)}
            >
              <ArrowDownUp className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">Organize</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuLabel className="text-caption font-medium text-muted-foreground">Organize</DropdownMenuLabel>
        {options.map(([option, label]) => (
          <DropdownMenuItem
            key={option}
            role="menuitemradio"
            aria-checked={value === option}
            onSelect={() => setChatHistoryOrganize(option)}
            className="gap-2"
          >
            <Check className={cn("h-3.5 w-3.5", value === option ? "opacity-100" : "opacity-0")} />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── the list ──

export function ChatHistoryList({
  sessions,
  activeSessionId,
  streamingSessionIds,
  onSelect,
  onNew,
  onNewGroup,
  onDelete,
  onRename,
  onTogglePin,
  renderGroups,
  surface,
  onClose,
  closeClassName,
  now,
}: ChatHistoryListProps) {
  const styles = historyStyles(surface);
  const orchestratorName = useOrchestratorName();
  const { agents } = useAgents();
  const organize = useChatHistoryOrganize();
  const [query, setQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<HistorySession | null>(null);
  const [collapsedAgents, setCollapsedAgents] = useState<Set<string>>(() => new Set());
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(() => new Set());
  const [limit, setLimit] = useState(HISTORY_PAGE_SIZE);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const agentMap = useMemo(
    () => new Map((agents ?? []).map((a) => [a.name, a] as const)),
    [agents],
  );
  const agentLabel = useCallback((key: string) => {
    if (key === ORCHESTRATOR_KEY) return orchestratorName;
    const agent = agentMap.get(key);
    return agent?.identity?.displayName ?? agent?.name ?? key;
  }, [agentMap, orchestratorName]);

  const streaming = useMemo(() => new Set(streamingSessionIds), [streamingSessionIds]);
  const searching = query.trim() !== "";
  const matching = useMemo(() => filterSessions(sessions, query, agentLabel), [sessions, query, agentLabel]);
  const pinned = useMemo(() => pinnedOf(matching), [matching]);
  const rest = useMemo(() => unpinnedOf(matching), [matching]);
  const clock = now ?? new Date();
  const clockDay = `${clock.getFullYear()}-${clock.getMonth()}-${clock.getDate()}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the buckets change with the day, not the instant
  const byDate = useMemo(() => groupByDate(rest, clock), [rest, clockDay]);
  const byAgent = useMemo(() => groupByAgent(rest, agentLabel), [rest, agentLabel]);

  // Infinite scroll ("By chat"): the next page when the end of the list comes into view.
  const total = organize === "chat" ? rest.length : 0;
  const hasMore = organize === "chat" && total > limit;
  useEffect(() => {
    if (!hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setLimit((l) => l + HISTORY_PAGE_SIZE);
    // the viewport as root: it also sees the sentinel through a scrolling list (clipped by it)
    }, { rootMargin: "200px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, limit]);

  // Keyboard: arrows move between rows, Delete asks to delete the focused chat.
  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const root = rootRef.current;
    if (!root) return;
    const rows = [...root.querySelectorAll<HTMLElement>("[data-history-row]")];
    // "/" goes to the search (not while typing somewhere)
    if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey
      && !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable)) {
      event.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if (target === searchRef.current) {
      if (event.key === "ArrowDown" && rows.length > 0) {
        event.preventDefault();
        rows[0].focus();
      } else if (event.key === "Escape" && query) {
        event.preventDefault();
        setQuery("");
      }
      return;
    }
    if (!target.hasAttribute("data-history-row")) return;
    const index = rows.indexOf(target);
    const move = (to: number) => {
      event.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
    };
    switch (event.key) {
      case "ArrowDown": move(index + 1); break;
      case "ArrowUp":
        if (index === 0) { event.preventDefault(); searchRef.current?.focus(); } else move(index - 1);
        break;
      case "Home": move(0); break;
      case "End": move(rows.length - 1); break;
      case "Delete":
      case "Backspace": {
        const id = target.dataset.sessionId;
        const session = id ? sessions.find((s) => s.id === id) : undefined;
        if (session) {
          event.preventDefault();
          setDeleteTarget(session);
        }
        break;
      }
    }
  }, [query, sessions]);

  const row = (session: HistorySession, showAgent: boolean) => {
    const key = agentKeyOf(session);
    return (
      <SessionRow
        key={session.id}
        session={session}
        active={session.id === activeSessionId}
        streaming={streaming.has(session.id)}
        agent={session.agent ? agentMap.get(session.agent) : undefined}
        agentName={agentLabel(key)}
        showAgent={showAgent}
        styles={styles}
        onSelect={onSelect}
        onRename={onRename}
        onTogglePin={onTogglePin}
        onAskDelete={setDeleteTarget}
      />
    );
  };

  const agentChoices = useMemo(
    () => [...(agents ?? [])].sort((a, b) => agentLabel(a.name).localeCompare(agentLabel(b.name))),
    [agents, agentLabel],
  );

  const renderByChat = () => {
    let budget = limit;
    const out: ReactNode[] = [];
    for (const section of byDate) {
      if (budget <= 0) break;
      const items = section.items.slice(0, budget);
      budget -= items.length;
      out.push(
        <section key={section.key} aria-label={section.label}>
          <SectionLabel styles={styles} sticky>{section.label}</SectionLabel>
          <div className="space-y-px">{items.map((s) => row(s, true))}</div>
        </section>,
      );
    }
    return out;
  };

  const renderByAgent = () => byAgent.map((section) => {
    const key = section.key;
    const agent = key !== ORCHESTRATOR_KEY ? agentMap.get(key) : undefined;
    const open = searching || !collapsedAgents.has(key);
    const showAll = searching || expandedAgents.has(key);
    const activeIndex = section.items.findIndex((s) => s.id === activeSessionId);
    const cap = showAll ? section.items.length : Math.max(AGENT_PREVIEW, activeIndex + 1);
    const visible = section.items.slice(0, cap);
    const hidden = section.items.length - visible.length;
    const toggle = () => setCollapsedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    return (
      <section key={key} aria-label={section.label} className="pt-1">
        <div className="group/agent relative">
          <button
            type="button"
            data-history-row
            aria-expanded={open}
            onClick={toggle}
            className={cn(styles.row, "pr-8", styles.rowIdle)}
          >
            <ChevronRight className={cn("h-3 w-3 shrink-0 opacity-50 transition-transform", open && "rotate-90")} />
            {agent
              ? (
                <RowAvatar
                  avatar={agent.identity?.avatar}
                  name={section.label}
                  color={agent.identity?.color}
                  size="xs"
                  fallbackVariant="circle"
                  shape="circle"
                />
              )
              : key === ORCHESTRATOR_KEY
                ? <OrchestratorMark className="size-5 text-caption" />
                : <RowAvatar name={section.label} size="xs" fallbackVariant="circle" shape="circle" />}
            <span className="min-w-0 flex-1 truncate font-medium">{section.label}</span>
            <span className={cn("text-micro tabular-nums transition-opacity group-hover/agent:opacity-0", styles.muted)}>
              {section.items.length}
            </span>
          </button>
          <NewChatMenu
            align="end"
            iconClassName="h-3.5 w-3.5"
            newChatLabel={`New chat with ${section.label}`}
            newGroupLabel={`New group with ${section.label}`}
            onNewChat={() => onNew(key !== ORCHESTRATOR_KEY ? key : undefined)}
            onNewGroup={() => onNewGroup(key !== ORCHESTRATOR_KEY ? key : ORCHESTRATOR_MEMBER_ID)}
            className={cn(
              "absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 rounded-md opacity-0 transition-opacity focus-visible:opacity-100 group-hover/agent:opacity-100 data-[state=open]:opacity-100",
              styles.iconButton,
            )}
          />
        </div>
        {open && (
          <div className="space-y-px pl-3">
            {visible.map((s) => row(s, false))}
            {(hidden > 0 || (expandedAgents.has(key) && section.items.length > AGENT_PREVIEW && !searching)) && (
              <button
                type="button"
                onClick={() => setExpandedAgents((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key); else next.add(key);
                  return next;
                })}
                className={cn(styles.row, styles.rowIdle, "py-1 text-caption")}
              >
                {hidden > 0 ? `Show ${hidden} more` : "Show less"}
              </button>
            )}
          </div>
        )}
      </section>
    );
  });

  const groupsNode = renderGroups?.(query) ?? null;
  const empty = sessions.length === 0;
  const noMatches = searching && matching.length === 0;

  return (
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      className={cn("flex min-h-0 flex-1 flex-col", surface === "panel" && "px-2 pt-2")}
    >
      {/* New chat + search */}
      <div className="shrink-0 space-y-px pb-1">
        <div className="flex items-center gap-1">
          <div className="group/new relative min-w-0 flex-1">
            <button
              type="button"
              data-history-row
              onClick={() => onNew()}
              className={cn(styles.row, "pr-8 font-medium", styles.rowIdle)}
            >
              <SquarePen className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">New chat</span>
            </button>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label="New chat options"
                      className={cn(
                        "absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md",
                        styles.iconButton,
                      )}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">New chat with an agent, or a group</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
                <DropdownMenuLabel className="text-caption font-medium text-muted-foreground">New chat with</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => onNew()} className="gap-2">
                  <OrchestratorMark className="size-4 text-micro" />
                  <span className="min-w-0 flex-1 truncate">{orchestratorName}</span>
                </DropdownMenuItem>
                {agentChoices.map((agent) => (
                  <DropdownMenuItem key={agent.name} onSelect={() => onNew(agent.name)} className="gap-2">
                    <RowAvatar
                      avatar={agent.identity?.avatar}
                      name={agentLabel(agent.name)}
                      color={agent.identity?.color}
                      size="xs"
                      className="size-4"
                      fallbackVariant="circle"
                      shape="circle"
                    />
                    <span className="min-w-0 flex-1 truncate">{agentLabel(agent.name)}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onNewGroup()} className="gap-2">
                  <UsersRound className="h-3.5 w-3.5" />
                  New group
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {onClose && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close chat history"
                  className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", styles.iconButton, closeClassName)}
                >
                  <X className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Close</TooltipContent>
            </Tooltip>
          )}
        </div>
        <label className={cn("flex cursor-text items-center gap-2 rounded-lg px-3 py-1.5 transition-colors", styles.search)}>
          <Search className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
          <input
            ref={searchRef}
            type="text"
            enterKeyHint="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            className="min-w-0 flex-1 bg-transparent text-small outline-none"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => { setQuery(""); searchRef.current?.focus(); }}
              className={cn("inline-flex h-5 w-5 items-center justify-center rounded-md", styles.iconButton)}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </label>
      </div>

      {/* The lists */}
      {/* In the mobile sheet the sheet itself scrolls: no nested scroll area there. */}
      <div
        ref={scrollRef}
        className={cn("pb-3", surface !== "sheet" && "min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain")}
      >
        {pinned.length > 0 && (
          <section aria-label="Pinned" className="pb-2">
            <SectionLabel styles={styles}>Pinned</SectionLabel>
            <div className="space-y-px">{pinned.map((s) => row(s, true))}</div>
          </section>
        )}

        {groupsNode}

        {empty && !searching ? (
          <p className={cn("px-3 pt-3 text-small", styles.muted)}>No chats yet</p>
        ) : noMatches ? (
          <p className={cn("px-3 pt-3 text-small", styles.muted)}>No chats match your search</p>
        ) : rest.length > 0 && (
          <div>
            <SectionLabel
              styles={styles}
              action={<OrganizeMenu value={organize} styles={styles} />}
            >
              {organize === "agent" ? "By agent" : "Recents"}
            </SectionLabel>
            {organize === "agent" ? renderByAgent() : renderByChat()}
            {hasMore && (
              <div ref={sentinelRef} className="px-3 pt-1">
                <button
                  type="button"
                  onClick={() => setLimit((l) => l + HISTORY_PAGE_SIZE)}
                  className={cn(styles.row, styles.rowIdle, "py-1 text-caption")}
                >
                  Show more
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete chat?"
        description={(
          <>
            <span className="font-medium text-foreground">{deleteTarget?.title || "Untitled"}</span>
            {" "}and its messages will be deleted. This can't be undone.
          </>
        )}
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target) onDelete(target.id);
        }}
      />
    </div>
  );
}
