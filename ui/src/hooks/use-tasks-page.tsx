/**
 * State management hook and context for the Tasks page.
 *
 * Extracts all filter, sort, grouping, view mode, and action logic
 * out of the page component into a reusable hook. Also provides a
 * TaskActionsContext to eliminate prop drilling through KanbanBoard →
 * KanbanColumn → GroupBlock → TaskCard.
 */

import { useState, useMemo, useCallback, createContext, use } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks, usePolpo, useProcesses, useMissions, useAgents } from "@lumea-technologies/polpo-react";
import type { Task } from "@lumea-technologies/polpo-react";
import type { FilterOption } from "@/components/shared/multi-select-filter";
import { useAsyncAction } from "@/hooks/use-polpo";
import { toast } from "sonner";
import { Target, Users } from "lucide-react";

// ── Re-export types used by the page ──

export type ViewMode = "list" | "kanban";
export type SortKey = "updated" | "created" | "name" | "status" | "priority" | "score";
export type GroupByKey = "none" | "status" | "mission" | "team" | "agent";
export type ColumnByKey = "status" | "mission" | "team" | "agent";
export type TimeField = "createdAt" | "updatedAt";
export type TimeRange = "1h" | "6h" | "24h" | "7d" | "30d" | "custom";

/** Toggleable fields on task cards. */
export interface CardFieldVisibility {
  avatar: boolean;
  identityName: boolean;
  agentId: boolean;
  mission: boolean;
  time: boolean;
  score: boolean;
  retries: boolean;
  deps: boolean;
  expectations: boolean;
  phase: boolean;
}

const DEFAULT_CARD_FIELDS: CardFieldVisibility = {
  avatar: true,
  identityName: true,
  agentId: true,
  mission: true,
  time: true,
  score: true,
  retries: false,
  deps: true,
  expectations: false,
  phase: true,
};

const CARD_FIELDS_KEY = "polpo-tasks-card-fields";

function loadCardFields(): CardFieldVisibility {
  try {
    const raw = localStorage.getItem(CARD_FIELDS_KEY);
    if (raw) return { ...DEFAULT_CARD_FIELDS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_CARD_FIELDS };
}

export interface TimeFilterState {
  field: TimeField;
  range: TimeRange;
  /** Epoch ms — resolved from preset or custom input */
  after: number;
}

// ── Sort helpers ──

import type { TaskStatus } from "@lumea-technologies/polpo-react";

const statusOrder: Record<TaskStatus, number> = {
  in_progress: 0,
  review: 1,
  awaiting_approval: 2,
  assigned: 3,
  pending: 4,
  draft: 5,
  failed: 6,
  done: 7,
};

function sortTasks(tasks: Task[], key: SortKey): Task[] {
  const sorted = [...tasks];
  switch (key) {
    case "updated":
      return sorted.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    case "created":
      return sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    case "name":
      return sorted.sort((a, b) => a.title.localeCompare(b.title));
    case "status":
      return sorted.sort((a, b) => (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99));
    case "priority":
      return sorted.sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1));
    case "score": {
      return sorted.sort((a, b) => {
        const sa = a.result?.assessment?.globalScore ?? -1;
        const sb = b.result?.assessment?.globalScore ?? -1;
        return sb - sa;
      });
    }
    default:
      return sorted;
  }
}

// ── Task Actions Context ──

export interface TaskActions {
  retry: (id: string) => void;
  kill: (id: string) => void;
  queue: (id: string) => void;
  click: (id: string) => void;
}

const TaskActionsContext = createContext<TaskActions | null>(null);

export function TaskActionsProvider({
  actions,
  children,
}: {
  actions: TaskActions;
  children: React.ReactNode;
}) {
  return (
    <TaskActionsContext value={actions}>
      {children}
    </TaskActionsContext>
  );
}

export function useTaskActions(): TaskActions {
  const ctx = use(TaskActionsContext);
  if (!ctx) throw new Error("useTaskActions must be used within TaskActionsProvider");
  return ctx;
}

// ── Main hook ──

export function useTasksPageState() {
  const navigate = useNavigate();
  const { tasks, isLoading: loading, refetch, retryTask } = useTasks();
  const { processes } = useProcesses();
  const { client } = usePolpo();
  const { missions } = useMissions();
  const { agents, teams, isLoading: teamsLoading } = useAgents();

  // ── Filter state ──
  const [search, setSearch] = useState("");
  const [selectedMissions, setSelectedMissions] = useState<Set<string>>(new Set());
  const [selectedTeams, setSelectedTeams] = useState<Set<string>>(new Set());
  const [timeFilter, setTimeFilter] = useState<TimeFilterState | null>(null);

  // ── View preferences (persisted to localStorage) ──
  const [viewMode, setViewModeState] = useState<ViewMode>(() => {
    return (localStorage.getItem("polpo-tasks-view") as ViewMode) ?? "list";
  });
  const [sortKey, setSortKeyState] = useState<SortKey>(() => {
    return (localStorage.getItem("polpo-tasks-sort") as SortKey) ?? "updated";
  });
  const [groupBy, setGroupByState] = useState<GroupByKey>(() => {
    // Migrate old boolean setting
    const legacy = localStorage.getItem("polpo-tasks-group-mission");
    if (legacy !== null) {
      localStorage.removeItem("polpo-tasks-group-mission");
      const val = legacy === "true" ? "mission" : "none";
      localStorage.setItem("polpo-tasks-group-by", val);
      return val as GroupByKey;
    }
    return (localStorage.getItem("polpo-tasks-group-by") as GroupByKey) ?? "mission";
  });
  const [columnBy, setColumnByState] = useState<ColumnByKey>(() => {
    return (localStorage.getItem("polpo-tasks-column-by") as ColumnByKey) ?? "status";
  });
  const [showEmptyColumns, setShowEmptyColumnsState] = useState(() => {
    return localStorage.getItem("polpo-tasks-show-empty-cols") === "true";
  });
  const [cardFields, setCardFieldsState] = useState<CardFieldVisibility>(loadCardFields);

  // ── Persisted setters ──
  const setViewMode = useCallback((mode: ViewMode) => {
    setViewModeState(mode);
    localStorage.setItem("polpo-tasks-view", mode);
  }, []);

  const setSortKey = useCallback((key: SortKey) => {
    setSortKeyState(key);
    localStorage.setItem("polpo-tasks-sort", key);
  }, []);

  const setGroupBy = useCallback((key: GroupByKey) => {
    setGroupByState(key);
    localStorage.setItem("polpo-tasks-group-by", key);
  }, []);

  const setColumnBy = useCallback((key: ColumnByKey) => {
    setColumnByState(key);
    localStorage.setItem("polpo-tasks-column-by", key);
  }, []);

  const toggleEmptyColumns = useCallback(() => {
    setShowEmptyColumnsState((prev) => {
      const next = !prev;
      localStorage.setItem("polpo-tasks-show-empty-cols", String(next));
      return next;
    });
  }, []);

  const toggleCardField = useCallback((field: keyof CardFieldVisibility) => {
    setCardFieldsState((prev) => {
      const next = { ...prev, [field]: !prev[field] };
      localStorage.setItem(CARD_FIELDS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // ── Filter toggles ──
  const toggleMission = useCallback((name: string) => {
    setSelectedMissions((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleTeam = useCallback((name: string) => {
    setSelectedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const clearAllFilters = useCallback(() => {
    setSelectedMissions(new Set());
    setSelectedTeams(new Set());
    setTimeFilter(null);
  }, []);

  // ── Derived data ──
  const agentTeamMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const team of teams) {
      for (const agent of team.agents) {
        m[agent.name] = team.name;
      }
    }
    return m;
  }, [teams]);

  /** Lookup map: agent name → AgentConfig (for avatar, identity, etc.) */
  const agentConfigMap = useMemo(() => {
    const m: Record<string, (typeof agents)[number]> = {};
    for (const a of agents) m[a.name] = a;
    return m;
  }, [agents]);

  const filtered = useMemo(() => {
    const result = tasks.filter((t) => {
      if (selectedMissions.size > 0 && !selectedMissions.has(t.group ?? "")) return false;
      if (selectedTeams.size > 0) {
        const agentTeam = agentTeamMap[t.assignTo];
        if (!agentTeam || !selectedTeams.has(agentTeam)) return false;
      }
      if (timeFilter) {
        const ts = new Date(t[timeFilter.field]).getTime();
        if (ts < timeFilter.after) return false;
      }
      if (search) {
        const q = search.toLowerCase();
        return (
          t.title.toLowerCase().includes(q) ||
          t.assignTo.toLowerCase().includes(q) ||
          (t.group ?? "").toLowerCase().includes(q)
        );
      }
      return true;
    });
    return sortTasks(result, sortKey);
  }, [tasks, search, selectedMissions, selectedTeams, agentTeamMap, sortKey, timeFilter]);

  const missionFilterOptions = useMemo((): FilterOption[] => {
    const names = new Set<string>();
    for (const p of missions) names.add(p.name);
    for (const t of tasks) {
      if (t.group) names.add(t.group);
    }
    return Array.from(names)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        value: name,
        icon: <Target className="h-3 w-3 text-muted-foreground shrink-0" />,
      }));
  }, [missions, tasks]);

  const teamFilterOptions = useMemo((): FilterOption[] => {
    return teams.map((t) => ({
      value: t.name,
      icon: <Users className="h-3 w-3 text-muted-foreground shrink-0" />,
    }));
  }, [teams]);

  const hasActiveFilters = selectedMissions.size > 0 || selectedTeams.size > 0 || timeFilter !== null;

  // ── Task actions (stable callbacks) ──
  const handleRetry = useCallback(async (id: string) => {
    try {
      await retryTask(id);
      toast.success("Task retried");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [retryTask]);

  const handleKill = useCallback(async (id: string) => {
    try {
      await client.killTask(id);
      toast.success("Task killed");
      refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [client, refetch]);

  const handleQueue = useCallback(async (id: string) => {
    try {
      await client.queueTask(id);
      toast.success("Task queued");
      refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [client, refetch]);

  const handleTaskClick = useCallback((id: string) => {
    navigate(`/tasks/${id}`);
  }, [navigate]);

  const [handleRefresh, isRefreshing] = useAsyncAction(async () => {
    await refetch();
  });

  const taskActions: TaskActions = useMemo(() => ({
    retry: handleRetry,
    kill: handleKill,
    queue: handleQueue,
    click: handleTaskClick,
  }), [handleRetry, handleKill, handleQueue, handleTaskClick]);

  return {
    // Data
    tasks,
    filtered,
    processes,
    loading,
    teamsLoading,

    // Filter state
    search,
    setSearch,
    selectedMissions,
    setSelectedMissions,
    selectedTeams,
    setSelectedTeams,
    timeFilter,
    setTimeFilter,
    hasActiveFilters,
    clearAllFilters,

    // Filter toggles
    toggleMission,
    toggleTeam,

    // Filter options
    missionFilterOptions,
    teamFilterOptions,

    // View preferences
    viewMode,
    setViewMode,
    sortKey,
    setSortKey,
    groupBy,
    setGroupBy,
    columnBy,
    setColumnBy,
    showEmptyColumns,
    toggleEmptyColumns,
    cardFields,
    toggleCardField,

    // Actions
    taskActions,
    handleRefresh,
    isRefreshing,

    // Derived
    agentTeamMap,
    agentConfigMap,
  } as const;
}
