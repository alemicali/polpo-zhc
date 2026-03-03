/**
 * AgentsPage — thin shell that composes provider + UI children.
 *
 * All data fetching and state management lives in AgentsPageProvider.
 * Each child component consumes context — no prop drilling.
 */

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Bot,
  Loader2,
  RefreshCw,
  Search,
  LayoutList,
  Network,
} from "lucide-react";
import { AgentsPageProvider, useAgentsPage } from "@/components/agents/agents-page-provider";
import { SummaryHeader } from "@/components/agents/agents-summary";
import { AddAgentDialog, AddTeamDialog } from "@/components/agents/agents-dialogs";
import { ListView } from "@/components/agents/agents-list-view";
import { OrgChartView } from "@/components/agents/agents-org-chart";
import { cn } from "@/lib/utils";

// ─── Toolbar ─────────────────────────────────────────────

function ViewToggle() {
  const { state, actions } = useAgentsPage();
  const { view } = state;

  return (
    <div className="flex items-center rounded-lg border border-border/40 bg-muted/20 p-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
              view === "chart" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => actions.setView("chart")}
          >
            <Network className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Org Chart</span>
          </button>
        </TooltipTrigger>
        <TooltipContent className="text-xs">Visual org chart with reporting structure</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
              view === "list" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => actions.setView("list")}
          >
            <LayoutList className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">List</span>
          </button>
        </TooltipTrigger>
        <TooltipContent className="text-xs">Grouped list view by team</TooltipContent>
      </Tooltip>
    </div>
  );
}

function SearchBar() {
  const { state, actions } = useAgentsPage();
  return (
    <div className="relative w-64">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        placeholder="Search agents..."
        className="pl-9 h-8 bg-input/50 border-border/40"
        value={state.search}
        onChange={(e) => actions.setSearch(e.target.value)}
      />
    </div>
  );
}

function RefreshButton() {
  const { state, actions } = useAgentsPage();
  return (
    <Button variant="outline" size="sm" onClick={actions.handleRefresh} disabled={state.isRefreshing}>
      <RefreshCw className={cn("h-3.5 w-3.5", state.isRefreshing && "animate-spin")} />
    </Button>
  );
}

function Toolbar() {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <ViewToggle />
        <SearchBar />
      </div>
      <div className="flex items-center gap-2">
        <AddTeamDialog />
        <AddAgentDialog />
        <RefreshButton />
      </div>
    </div>
  );
}

// ─── Empty state ─────────────────────────────────────────

function EmptyState() {
  return (
    <Card className="bg-card/60 backdrop-blur-sm flex-1">
      <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground h-full">
        <Bot className="h-12 w-12 mb-4 opacity-40" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="text-xs mt-1 text-center max-w-sm">
          Create a team and add your first agent to get started. Agents are saved in your project configuration.
        </p>
        <div className="mt-4 flex items-center gap-2">
          <AddTeamDialog />
          <AddAgentDialog />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Content switcher ────────────────────────────────────

function AgentsContent() {
  const { state } = useAgentsPage();
  const { agents, search, view } = state;

  if (agents.length === 0 && !search) {
    return <EmptyState />;
  }

  return view === "chart" ? <OrgChartView /> : <ListView />;
}

// ─── Loading state ───────────────────────────────────────

function LoadingState() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

function AgentsPageInner() {
  const { state } = useAgentsPage();

  if (state.isLoading) {
    return <LoadingState />;
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <SummaryHeader />
      <Toolbar />
      <AgentsContent />
    </div>
  );
}

// ─── Exported page (provider + children) ─────────────────

export function AgentsPage() {
  return (
    <AgentsPageProvider>
      <AgentsPageInner />
    </AgentsPageProvider>
  );
}
