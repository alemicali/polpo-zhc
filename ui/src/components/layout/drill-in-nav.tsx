/**
 * DrillInNav — the drill-in sidebar: the top level lists Dashboard, Chat, Approvals and the
 * groups (Work, Team, Content, Tools, Settings); opening a group shows its entries as a new
 * level inside the sidebar, with a Back row on top. The tree is lib/nav-tree.ts (any depth).
 *
 * - Forward, the new level slides in from the right and the old one out to the left; back, the
 *   reverse. No motion with prefers-reduced-motion, and none on the first render.
 * - The current route picks the level: on /tasks the Work level is open with Tasks current;
 *   navigating elsewhere (a link in a page) follows it.
 * - Keyboard: ↑/↓/Home/End move between entries, Enter or → opens a group, ← / Escape / Back go
 *   up; focus moves to the first entry of the new level.
 *
 * Used by the sidebar (expanded and the collapsed icon rail) and the mobile navigation sheet.
 */
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, History, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DRILL_IN_NAV,
  findActiveTrail,
  findGroup,
  isLinkActive,
  isNodeActive,
  type NavBadge,
  type NavEntry,
  type NavGroupNode,
  type NavNode,
  type NavPanel,
} from "@/lib/nav-tree";
import { PendingBadge } from "./pending-badge";

const ChatHistoryPanel = lazy(() =>
  import("@/pages/chat").then((m) => ({ default: m.ChatHistoryPanel })),
);

type Direction = "forward" | "back";
interface Transition {
  dir: Direction;
  /** The level leaving the screen. */
  from: string[];
  id: number;
}

/** How long the slide lasts (the duration-200 below), plus a margin: then the old level goes. */
const TRANSITION_FALLBACK_MS = 320;

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function sameStack(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function isPrefix(prefix: string[], of: string[]): boolean {
  return prefix.length < of.length && prefix.every((id, i) => id === of[i]);
}

function directionOf(from: string[], to: string[]): Direction {
  if (isPrefix(from, to)) return "forward";
  if (isPrefix(to, from)) return "back";
  return to.length >= from.length ? "forward" : "back";
}

const ENTER: Record<Direction, string> = {
  forward: "animate-in fade-in slide-in-from-right-8 duration-200 ease-out motion-reduce:animate-none",
  back: "animate-in fade-in slide-in-from-left-8 duration-200 ease-out motion-reduce:animate-none",
};
const LEAVE: Record<Direction, string> = {
  forward: "animate-out fade-out slide-out-to-left-8 duration-200 ease-out fill-mode-forwards motion-reduce:hidden",
  back: "animate-out fade-out slide-out-to-right-8 duration-200 ease-out fill-mode-forwards motion-reduce:hidden",
};

function Badge({ badge, collapsed }: { badge?: NavBadge; collapsed: boolean }) {
  if (badge === "approvals") return <PendingBadge collapsed={collapsed} />;
  return null;
}

export interface DrillInNavProps {
  /** sidebar: the desktop sidebar; sheet: the mobile navigation drawer. */
  variant?: "sidebar" | "sheet";
  /** The icon rail (the sidebar collapsed). */
  collapsed?: boolean;
  /** After following a link (the sheet closes). */
  onNavigate?: () => void;
  /** The rail asks for the full sidebar (to show the chat history). */
  onExpand?: () => void;
  className?: string;
  /** The tree (tests, later trees); the dashboard's by default. */
  tree?: NavNode[];
}

export function DrillInNav({ variant = "sidebar", collapsed = false, onNavigate, onExpand, className, tree = DRILL_IN_NAV }: DrillInNavProps) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const headingId = useId();
  const levelRef = useRef<HTMLDivElement>(null);
  const trailIds = (p: string, s: string) => findActiveTrail(tree, p, s)?.map((g) => g.id) ?? null;

  // The level: a path of group ids from the top ([] = the top level). Opens where the route is.
  const [stack, setStack] = useState<string[]>(() => trailIds(pathname, search) ?? []);
  const [transition, setTransition] = useState<Transition | null>(null);
  // Bumped when the person opens or leaves a level: focus goes to its first entry.
  const [focusRequest, setFocusRequest] = useState(0);

  const moveTo = (next: string[], focus: boolean) => {
    if (sameStack(stack, next)) return;
    setTransition(prefersReducedMotion() ? null : { dir: directionOf(stack, next), from: stack, id: (transition?.id ?? 0) + 1 });
    setStack(next);
    if (focus) setFocusRequest((n) => n + 1);
  };

  // Follow the route (a link in a page, the browser's back button): adjusted during render.
  const locationKey = `${pathname}${search}`;
  const [seenLocation, setSeenLocation] = useState(locationKey);
  if (seenLocation !== locationKey) {
    setSeenLocation(locationKey);
    const trail = trailIds(pathname, search);
    if (trail && !sameStack(trail, stack)) moveTo(trail, false);
  }

  // The old level leaves when its slide ends (or soon after, if no animation event comes).
  useEffect(() => {
    if (!transition) return;
    const timer = window.setTimeout(() => setTransition((t) => (t?.id === transition.id ? null : t)), TRANSITION_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [transition]);

  // Focus the first entry of a level the person opened (keyboard or click).
  useEffect(() => {
    if (!focusRequest) return;
    const root = levelRef.current;
    const target = root?.querySelector<HTMLElement>("[data-nav-item]") ?? root?.querySelector<HTMLElement>("[data-nav-back]");
    target?.focus();
  }, [focusRequest]);

  const openGroup = (group: NavGroupNode, path: string[]) => {
    moveTo([...path, group.id], true);
    if (group.to && !isLinkActive(group.to, pathname, search)) navigate(group.to);
  };

  const goUp = () => {
    if (stack.length) moveTo(stack.slice(0, -1), true);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const root = levelRef.current;
    const target = event.target as HTMLElement;
    if (!root || !root.contains(target)) return; // a menu or dialog portalled from inside
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    const items = [...root.querySelectorAll<HTMLElement>("[data-nav-back], [data-nav-item]")];
    const index = items.indexOf(target);
    const onItem = index !== -1;
    const focusAt = (i: number) => {
      event.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        if (onItem) focusAt(index + 1);
        break;
      case "ArrowUp":
        if (onItem) focusAt(index - 1);
        break;
      case "Home":
        if (onItem) focusAt(0);
        break;
      case "End":
        if (onItem) focusAt(items.length - 1);
        break;
      case "ArrowRight":
        if (target.hasAttribute("data-nav-group")) {
          event.preventDefault();
          target.click();
        }
        break;
      case "ArrowLeft":
        if (!onItem) break;
        if (stack.length) {
          event.preventDefault();
          goUp();
        }
        break;
      case "Escape":
        if (stack.length) {
          // inside a level Escape goes up (it does not close the mobile sheet)
          event.preventDefault();
          event.stopPropagation();
          goUp();
        }
        break;
    }
  };

  const level = (path: string[], live: boolean) => (
    <Level
      path={path}
      tree={tree}
      live={live}
      collapsed={collapsed}
      variant={variant}
      headingId={live ? headingId : undefined}
      pathname={pathname}
      search={search}
      onOpenGroup={openGroup}
      onBack={goUp}
      onNavigate={onNavigate}
      onExpand={onExpand}
      onOpenChat={() => {
        if (pathname !== "/chat") navigate("/chat");
        onNavigate?.();
      }}
    />
  );

  return (
    <nav
      aria-label="Main navigation"
      data-sidebar-style="drill-in"
      className={cn("relative flex min-h-0 flex-col overflow-hidden", className)}
    >
      <div
        key={stack.join("/") || "top"}
        ref={levelRef}
        data-level={stack.at(-1) ?? "top"}
        data-motion={transition ? transition.dir : "none"}
        onKeyDown={onKeyDown}
        className={cn("flex min-h-0 flex-1 flex-col", transition && ENTER[transition.dir])}
      >
        {level(stack, true)}
      </div>
      {transition && (
        <div
          aria-hidden="true"
          inert
          data-leaving-level={transition.from.at(-1) ?? "top"}
          onAnimationEnd={() => setTransition((t) => (t?.id === transition.id ? null : t))}
          className={cn("pointer-events-none absolute inset-0 flex flex-col", LEAVE[transition.dir])}
        >
          {level(transition.from, false)}
        </div>
      )}
    </nav>
  );
}

// ── One level ──

interface LevelProps {
  path: string[];
  tree: NavNode[];
  /** The level on screen (false: the one sliding away — no panels, no ids). */
  live: boolean;
  collapsed: boolean;
  variant: "sidebar" | "sheet";
  headingId?: string;
  pathname: string;
  search: string;
  onOpenGroup: (group: NavGroupNode, path: string[]) => void;
  onBack: () => void;
  onNavigate?: () => void;
  onExpand?: () => void;
  onOpenChat: () => void;
}

function Level({ path, tree, live, collapsed, variant, headingId, pathname, search, onOpenGroup, onBack, onNavigate, onExpand, onOpenChat }: LevelProps) {
  const group = path.length ? findGroup(tree, path[path.length - 1]) : undefined;
  const entries: NavEntry[] = group ? group.children : tree;
  const parent = path.length > 1 ? findGroup(tree, path[path.length - 2]) : undefined;
  const backLabel = `Back to ${parent?.label ?? "main menu"}`;
  const sheet = variant === "sheet";

  const list = (
    <ul
      role="list"
      aria-labelledby={group ? headingId : undefined}
      aria-label={group ? undefined : "Pages"}
      className={cn("flex flex-col gap-0.5", collapsed ? "items-center" : "")}
    >
      {entries.map((entry) => (
        <li key={entry.id} className={cn(collapsed && "flex justify-center")}>
          {entry.kind === "section" ? (
            collapsed
              ? <div role="presentation" className="mx-auto my-1.5 h-px w-5 bg-sidebar-border" />
              : <div className={cn("px-3 pb-1 pt-3 text-label", sheet ? "text-muted-foreground/60" : "text-sidebar-foreground/50")}>{entry.label}</div>
          ) : (
            <Entry
              node={entry}
              collapsed={collapsed}
              sheet={sheet}
              active={isNodeActive(entry, pathname, search)}
              onOpen={() => entry.kind === "group" && onOpenGroup(entry, path)}
              onNavigate={onNavigate}
            />
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", collapsed ? "items-center py-3" : sheet ? "px-1" : "p-3")}>
      {group && (
        <BackRow
          label={group.label}
          backLabel={backLabel}
          headingId={headingId}
          collapsed={collapsed}
          sheet={sheet}
          onBack={onBack}
        />
      )}
      {entries.length > 0 && (
        <div className={cn("min-h-0", group?.panel ? "shrink-0" : "flex-1 overflow-y-auto overflow-x-hidden overscroll-contain", collapsed && "w-full")}>
          {list}
        </div>
      )}
      {group?.panel && (
        <PanelSlot panel={group.panel} live={live} collapsed={collapsed} sheet={sheet} onExpand={onExpand} onOpenChat={onOpenChat} />
      )}
    </div>
  );
}

function BackRow({ label, backLabel, headingId, collapsed, sheet, onBack }: {
  label: string;
  backLabel: string;
  headingId?: string;
  collapsed: boolean;
  sheet: boolean;
  onBack: () => void;
}) {
  if (collapsed) {
    return (
      <div className="mb-2 flex flex-col items-center gap-1 border-b border-sidebar-border pb-2">
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-nav-back
              aria-label={backLabel}
              onClick={onBack}
              className="flex h-10 w-10 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs font-medium">{backLabel}</TooltipContent>
        </Tooltip>
        <span id={headingId} className="sr-only">{label}</span>
      </div>
    );
  }
  return (
    <div className={cn("mb-2 shrink-0 border-b pb-2", sheet ? "border-border/50" : "border-sidebar-border")}>
      <button
        type="button"
        data-nav-back
        aria-label={backLabel}
        onClick={onBack}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          sheet
            ? "text-muted-foreground hover:bg-accent hover:text-foreground"
            : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        )}
      >
        <ChevronLeft className="h-4 w-4 shrink-0" />
        <span>Back</span>
      </button>
      <h2 id={headingId} className={cn("mt-1 truncate px-3 text-sm font-semibold", sheet ? "text-foreground" : "text-sidebar-foreground")}>
        {label}
      </h2>
    </div>
  );
}

function Entry({ node, collapsed, sheet, active, onOpen, onNavigate }: {
  node: NavNode;
  collapsed: boolean;
  sheet: boolean;
  active: boolean;
  onOpen: () => void;
  onNavigate?: () => void;
}) {
  const Icon = node.icon;
  const isGroup = node.kind === "group";
  const tone = active
    ? sheet ? "bg-primary/10 text-primary" : "bg-sidebar-primary/10 text-sidebar-primary"
    : sheet
      ? "text-foreground/80 hover:bg-accent hover:text-foreground"
      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";
  const shape = collapsed
    ? "relative flex h-10 w-10 items-center justify-center rounded-lg outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
    : cn("relative flex w-full items-center gap-3 rounded-lg px-3 text-left font-medium outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-sidebar-ring", sheet ? "py-3 text-sm" : "py-2.5 text-small");

  const content: ReactNode = collapsed ? (
    <>
      <Icon className="h-4 w-4" />
      <Badge badge={node.badge} collapsed />
      {isGroup && <ChevronRight aria-hidden className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 opacity-50" />}
    </>
  ) : (
    <>
      <Icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{node.label}</span>
      <Badge badge={node.badge} collapsed={false} />
      {isGroup && <ChevronRight aria-hidden className="h-4 w-4 shrink-0 opacity-50" />}
    </>
  );

  const control = isGroup ? (
    <button
      type="button"
      data-nav-item
      data-nav-group
      aria-label={collapsed ? node.label : undefined}
      title={collapsed ? undefined : `Open ${node.label}`}
      onClick={onOpen}
      className={cn(shape, tone)}
    >
      {content}
    </button>
  ) : (
    <Link
      to={node.to}
      data-nav-item
      aria-label={collapsed ? node.label : undefined}
      aria-current={active ? "page" : undefined}
      onClick={() => onNavigate?.()}
      className={cn(shape, tone)}
    >
      {content}
    </Link>
  );

  if (!collapsed) return control;
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>{control}</TooltipTrigger>
      <TooltipContent side="right" className="text-xs font-medium">{node.label}</TooltipContent>
    </Tooltip>
  );
}

function PanelSlot({ panel, live, collapsed, sheet, onExpand, onOpenChat }: {
  panel: NavPanel;
  live: boolean;
  collapsed: boolean;
  sheet: boolean;
  onExpand?: () => void;
  onOpenChat: () => void;
}) {
  if (panel !== "chat-history" || !live) return <div className="min-h-0 flex-1" />;
  if (collapsed) {
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-nav-item
            aria-label="Show chat history"
            onClick={() => onExpand?.()}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <History className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs font-medium">Show chat history</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <div
      role="region"
      aria-label="Chat history"
      className={cn("flex min-h-0 flex-col overflow-hidden rounded-lg border", sheet ? "h-96 border-border/50" : "-mx-1 flex-1 border-sidebar-border")}
    >
      <Suspense
        fallback={(
          <div className="flex flex-1 items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
      >
        <ChatHistoryPanel onOpenChat={onOpenChat} />
      </Suspense>
    </div>
  );
}
