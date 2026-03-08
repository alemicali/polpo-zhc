import { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sparkles,
  Search,
  Loader2,
  RefreshCw,
  Wrench,
  Bot,
  Tag,
  Layers,
  ChevronRight,
  Globe,
  HardDrive,
  X,
  LayoutList,
  LayoutGrid,
  Check,
} from "lucide-react";
import { useSkills, useAgents } from "@polpo-ai/react";
import type { SkillWithAssignment, Team } from "@polpo-ai/react";
import { cn } from "@/lib/utils";

// ── Helpers ──

function buildAgentTeamMap(teams: Team[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const team of teams) {
    for (const agent of team.agents) {
      map.set(agent.name, team.name);
    }
  }
  return map;
}

// ── Source icon ──

function SourceIcon({ source, className }: { source: string; className?: string }) {
  return source === "global"
    ? <Globe className={cn("h-3 w-3 text-sky-400", className)} />
    : <HardDrive className={cn("h-3 w-3 text-emerald-400/60", className)} />;
}

// ── Multi-select filter popover ──

function MultiFilter({
  icon,
  label,
  options,
  selected,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const count = selected.size;

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  if (options.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-2.5 h-8 text-xs transition-colors",
            count > 0
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border/40 bg-card/80 text-muted-foreground hover:text-foreground hover:border-border/60",
          )}
        >
          {icon}
          <span>{label}</span>
          {count > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground px-1">
              {count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
          <span className="text-xs font-medium">{label}</span>
          {count > 0 && (
            <button
              onClick={() => onChange(new Set())}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear
            </button>
          )}
        </div>
        {/* Options */}
        <ScrollArea className="max-h-56">
          <div className="py-1">
            {options.map((opt) => {
              const isSelected = selected.has(opt);
              return (
                <button
                  key={opt}
                  onClick={() => toggle(opt)}
                  className={cn(
                    "flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors",
                    isSelected
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border transition-colors",
                      isSelected
                        ? "border-primary bg-primary"
                        : "border-border/60",
                    )}
                  >
                    {isSelected && (
                      <Check className="h-2.5 w-2.5 text-primary-foreground" />
                    )}
                  </span>
                  <span className="truncate">{opt}</span>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

// ── Stat chip ──

function StatChip({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={cn(
          "text-xs font-bold tabular-nums",
          accent ? "text-primary" : "text-foreground",
        )}
      >
        {value}
      </span>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}

// ── Skill row (list view) ──

function SkillRow({
  skill,
  onClick,
}: {
  skill: SkillWithAssignment;
  onClick: () => void;
}) {
  const hasTags = skill.tags && skill.tags.length > 0;

  return (
    <button
      className={cn(
        "group flex items-center gap-4 w-full text-left rounded-lg border border-border/40",
        "bg-card/80 backdrop-blur-sm px-4 py-3",
        "transition-all hover:border-primary/20 hover:bg-accent/5",
        "hover:shadow-[0_0_20px_oklch(0.7_0.15_200_/_6%)]",
      )}
      onClick={onClick}
    >
      {/* Name + category + description + tags */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate group-hover:text-primary transition-colors">
            {skill.name}
          </span>
          {skill.category && (
            <span className="text-[10px] text-amber-300/80 shrink-0">
              {skill.category}
            </span>
          )}
          <SourceIcon source={skill.source} />
        </div>
        {(skill.description || hasTags) && (
          <div className="flex items-center gap-2 mt-0.5 min-w-0">
            {skill.description && (
              <p className="text-[11px] text-muted-foreground line-clamp-1 min-w-0">
                {skill.description}
              </p>
            )}
            {hasTags && (
              <div className="hidden md:flex items-center gap-1 shrink-0">
                {skill.tags!.slice(0, 2).map((tag) => (
                  <Badge
                    key={tag}
                    variant="outline"
                    className="text-[9px] py-0 px-1.5 bg-blue-500/10 text-blue-300 border-blue-500/20 shrink-0"
                  >
                    {tag}
                  </Badge>
                ))}
                {skill.tags!.length > 2 && (
                  <span className="text-[9px] text-muted-foreground shrink-0">
                    +{skill.tags!.length - 2}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Agents count */}
      <div className="flex items-center gap-1.5 shrink-0">
        <Bot className="h-3 w-3 text-muted-foreground" />
        <span
          className={cn(
            "text-xs font-medium tabular-nums",
            skill.assignedTo.length > 0 ? "text-foreground" : "text-muted-foreground/40",
          )}
        >
          {skill.assignedTo.length}
        </span>
      </div>

      {/* Tools count */}
      {Array.isArray(skill.allowedTools) && skill.allowedTools.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="hidden sm:flex items-center gap-1 shrink-0">
              <Wrench className="h-3 w-3 text-muted-foreground" />
              <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
                {skill.allowedTools.length}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent className="text-xs">
            {skill.allowedTools.slice(0, 8).join(", ")}
            {skill.allowedTools.length > 8 && ` +${skill.allowedTools.length - 8}`}
          </TooltipContent>
        </Tooltip>
      )}

      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
    </button>
  );
}

// ── Skill card (grid view) ──

function SkillCard({
  skill,
  agentTeamMap,
  onClick,
}: {
  skill: SkillWithAssignment;
  agentTeamMap: Map<string, string>;
  onClick: () => void;
}) {
  const hasTags = skill.tags && skill.tags.length > 0;

  return (
    <button
      className={cn(
        "group flex flex-col text-left rounded-lg border border-border/40",
        "bg-card/80 backdrop-blur-sm p-4",
        "transition-all hover:border-primary/20 hover:bg-accent/5",
        "hover:shadow-[0_0_20px_oklch(0.7_0.15_200_/_6%)]",
        "h-full",
      )}
      onClick={onClick}
    >
      {/* Header: name + category */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate group-hover:text-primary transition-colors">
            {skill.name}
          </span>
          {skill.category && (
            <span className="text-[10px] text-amber-300/80 shrink-0">
              {skill.category}
            </span>
          )}
          <SourceIcon source={skill.source} className="ml-auto" />
        </div>
        {skill.description && (
          <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
            {skill.description}
          </p>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bottom section */}
      <div className="mt-3 pt-3 border-t border-border/20 space-y-2">
        {/* Tags */}
        {hasTags && (
          <div className="flex flex-wrap gap-1">
            {skill.tags!.slice(0, 3).map((tag) => (
              <Badge
                key={tag}
                variant="outline"
                className="text-[9px] py-0 px-1.5 bg-blue-500/10 text-blue-300 border-blue-500/20"
              >
                {tag}
              </Badge>
            ))}
            {skill.tags!.length > 3 && (
              <span className="text-[9px] text-muted-foreground self-center">
                +{skill.tags!.length - 3}
              </span>
            )}
          </div>
        )}

        {/* Stats row */}
        <div className="flex items-center gap-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1">
                <Bot className="h-3 w-3 text-muted-foreground" />
                <span
                  className={cn(
                    "text-[11px] font-medium tabular-nums",
                    skill.assignedTo.length > 0 ? "text-foreground" : "text-muted-foreground/40",
                  )}
                >
                  {skill.assignedTo.length}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent className="text-xs">
              {skill.assignedTo.length > 0
                ? `Assigned to: ${skill.assignedTo.join(", ")}`
                : "Not assigned"}
            </TooltipContent>
          </Tooltip>

          {Array.isArray(skill.allowedTools) && skill.allowedTools.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1">
                  <Wrench className="h-3 w-3 text-muted-foreground" />
                  <span className="text-[11px] font-mono text-muted-foreground tabular-nums">
                    {skill.allowedTools.length}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent className="text-xs">
                Tools: {skill.allowedTools.slice(0, 6).join(", ")}
                {skill.allowedTools.length > 6 && ` +${skill.allowedTools.length - 6}`}
              </TooltipContent>
            </Tooltip>
          )}

          {/* Agents preview */}
          {skill.assignedTo.length > 0 && (
            <div className="flex items-center gap-0.5 ml-auto">
              {skill.assignedTo.slice(0, 3).map((agent) => (
                <Tooltip key={agent}>
                  <TooltipTrigger asChild>
                    <span className="flex h-5 items-center rounded-full bg-secondary px-1.5">
                      <span className="text-[9px] font-medium text-secondary-foreground truncate max-w-[60px]">
                        {agent}
                      </span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">
                    {agentTeamMap.get(agent)
                      ? `${agent} (${agentTeamMap.get(agent)})`
                      : agent}
                  </TooltipContent>
                </Tooltip>
              ))}
              {skill.assignedTo.length > 3 && (
                <span className="text-[9px] text-muted-foreground ml-0.5">
                  +{skill.assignedTo.length - 3}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

// ── Empty state ──

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-violet-500/5 border border-violet-500/10">
        <Sparkles className="h-8 w-8 text-violet-400/30" />
      </div>
      <div className="text-center space-y-1">
        <p className="text-sm font-medium text-foreground/60">
          {filtered ? "No skills match your filters" : "No skills discovered"}
        </p>
        <p className="text-xs">
          {filtered
            ? "Try adjusting your search or filter criteria"
            : "Install skills with polpo skills add <owner/repo>"}
        </p>
      </div>
    </div>
  );
}

// ── Active filter pill ──

function FilterPill({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 border border-primary/20 px-2 py-0.5 text-[10px] font-medium text-primary">
      {label}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClear();
        }}
        className="rounded-full p-0.5 hover:bg-primary/20 transition-colors"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}

// ── Main ──

type ViewMode = "list" | "grid";

export function SkillsPage() {
  const navigate = useNavigate();
  const { skills, isLoading, error, refetch } = useSkills();
  const { agents, teams } = useAgents();
  const [search, setSearch] = useState("");
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [view, setView] = useState<ViewMode>("list");

  const agentTeamMap = useMemo(() => buildAgentTeamMap(teams), [teams]);

  // Unique categories and tags
  const allCategories = useMemo(() => {
    const cats = new Set<string>();
    for (const s of skills) {
      if (s.category) cats.add(s.category);
    }
    return [...cats].sort();
  }, [skills]);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const s of skills) {
      if (s.tags) for (const t of s.tags) tags.add(t);
    }
    return [...tags].sort();
  }, [skills]);

  const allAgentNames = useMemo(
    () => agents.map((a) => a.name).sort(),
    [agents],
  );

  // Filtered skills
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return skills.filter((skill) => {
      // Text search
      if (
        q &&
        !skill.name.toLowerCase().includes(q) &&
        !skill.description.toLowerCase().includes(q) &&
        !skill.tags?.some((t) => t.toLowerCase().includes(q))
      ) {
        return false;
      }
      // Agent filter (OR — skill must be assigned to at least one selected agent)
      if (selectedAgents.size > 0) {
        if (!skill.assignedTo.some((a) => selectedAgents.has(a))) return false;
      }
      // Category filter (OR — skill must match at least one selected category)
      if (selectedCategories.size > 0) {
        if (!skill.category || !selectedCategories.has(skill.category))
          return false;
      }
      // Tag filter (OR — skill must have at least one selected tag)
      if (selectedTags.size > 0) {
        if (!skill.tags?.some((t) => selectedTags.has(t))) return false;
      }
      return true;
    });
  }, [skills, search, selectedAgents, selectedCategories, selectedTags]);

  // Stats
  const stats = useMemo(() => {
    let totalAssignments = 0;
    let unassigned = 0;
    for (const s of skills) {
      totalAssignments += s.assignedTo.length;
      if (s.assignedTo.length === 0) unassigned++;
    }
    return { total: skills.length, totalAssignments, unassigned };
  }, [skills]);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await refetch();
    } finally {
      setIsRefreshing(false);
    }
  }, [refetch]);

  const isFiltered =
    search.trim() !== "" ||
    selectedAgents.size > 0 ||
    selectedCategories.size > 0 ||
    selectedTags.size > 0;

  const clearAllFilters = () => {
    setSearch("");
    setSelectedAgents(new Set());
    setSelectedCategories(new Set());
    setSelectedTags(new Set());
  };

  // ── Loading ──
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // ── Error ──
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <Sparkles className="h-10 w-10 opacity-40" />
        <p className="text-sm">{error.message ?? "Could not load skills"}</p>
        <Button variant="outline" size="sm" onClick={handleRefresh}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* ── Summary bar ── */}
      <div className="flex items-center gap-3 rounded-lg border border-border/40 bg-card/80 backdrop-blur-sm px-3 py-2 shrink-0">
        <div className="flex items-center gap-4">
          <StatChip label="skills" value={stats.total} accent />
          <div className="h-4 w-px bg-border/60" />
          <StatChip label="assignments" value={stats.totalAssignments} />
          <div className="h-4 w-px bg-border/60" />
          <StatChip label="unassigned" value={stats.unassigned} />
        </div>
        <div className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            onClick={handleRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")}
            />
          </Button>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        {/* View toggle */}
        <div className="flex items-center rounded-lg border border-border/40 bg-muted/20 p-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                  view === "list"
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setView("list")}
              >
                <LayoutList className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="text-xs">List view</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                  view === "grid"
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setView("grid")}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="text-xs">Grid view</TooltipContent>
          </Tooltip>
        </div>

        {/* Search */}
        <div className="relative flex-1 min-w-44 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search skills..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-xs bg-input/50 border-border/40"
          />
        </div>

        {/* Agent filter */}
        <MultiFilter
          icon={<Bot className="h-3 w-3" />}
          label="Agents"
          options={allAgentNames}
          selected={selectedAgents}
          onChange={setSelectedAgents}
        />

        {/* Category filter */}
        <MultiFilter
          icon={<Layers className="h-3 w-3" />}
          label="Category"
          options={allCategories}
          selected={selectedCategories}
          onChange={setSelectedCategories}
        />

        {/* Tag filter */}
        <MultiFilter
          icon={<Tag className="h-3 w-3" />}
          label="Tags"
          options={allTags}
          selected={selectedTags}
          onChange={setSelectedTags}
        />
      </div>

      {/* ── Active filter pills ── */}
      {isFiltered && (
        <div className="flex items-center gap-1.5 flex-wrap shrink-0">
          <span className="text-[10px] text-muted-foreground mr-1">
            {filtered.length} of {skills.length}
          </span>
          {search.trim() && (
            <FilterPill
              label={`"${search.trim()}"`}
              onClear={() => setSearch("")}
            />
          )}
          {[...selectedAgents].map((a) => (
            <FilterPill
              key={`agent-${a}`}
              label={a}
              onClear={() => {
                const next = new Set(selectedAgents);
                next.delete(a);
                setSelectedAgents(next);
              }}
            />
          ))}
          {[...selectedCategories].map((c) => (
            <FilterPill
              key={`cat-${c}`}
              label={c}
              onClear={() => {
                const next = new Set(selectedCategories);
                next.delete(c);
                setSelectedCategories(next);
              }}
            />
          ))}
          {[...selectedTags].map((t) => (
            <FilterPill
              key={`tag-${t}`}
              label={t}
              onClear={() => {
                const next = new Set(selectedTags);
                next.delete(t);
                setSelectedTags(next);
              }}
            />
          ))}
          <button
            onClick={clearAllFilters}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors ml-1"
          >
            Clear all
          </button>
        </div>
      )}

      {/* ── Results ── */}
      <div className="flex-1 overflow-auto pb-bottom-nav lg:pb-2">
        {filtered.length > 0 ? (
          view === "list" ? (
            <div className="space-y-1.5">
              {filtered.map((skill) => (
                <SkillRow
                  key={skill.name}
                  skill={skill}
                  onClick={() =>
                    navigate(`/skills/${encodeURIComponent(skill.name)}`)
                  }
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered.map((skill) => (
                <SkillCard
                  key={skill.name}
                  skill={skill}
                  agentTeamMap={agentTeamMap}
                  onClick={() =>
                    navigate(`/skills/${encodeURIComponent(skill.name)}`)
                  }
                />
              ))}
            </div>
          )
        ) : (
          <EmptyState filtered={isFiltered} />
        )}
      </div>
    </div>
  );
}
