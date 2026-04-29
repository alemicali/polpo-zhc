/**
 * AgentDetailPage — thin composition shell.
 *
 * All data fetching lives in AgentDetailProvider (context).
 * Each visual section is a standalone component that reads
 * from context via useAgentDetail().
 *
 * Structure follows the Vercel composition patterns:
 * - Provider lifts state, UI composes children
 * - No boolean props, no render props
 * - Explicit variant components for each tab
 */

import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Bot,
  Brain,
  Loader2,
  ArrowLeft,
  RefreshCw,
  ChevronRight,
} from "lucide-react";
import { AgentAvatar } from "@/components/shared/agent-avatar";
// Provider + context hook
import {
  AgentDetailProvider,
  useAgentDetail,
} from "@/components/agents/agent-detail-provider";

// Sidebar cards
import { AgentHeroCard } from "@/components/agents/agent-hero-card";
import { AgentSocialsCard } from "@/components/agents/agent-socials-card";
import { AgentHierarchyCard } from "@/components/agents/agent-hierarchy-card";
import { AgentPerformanceCard } from "@/components/agents/agent-performance-card";

// Content area
import { LiveActivity } from "@/components/agents/live-activity";
import { ActivityHeatmap } from "@/components/agents/activity-heatmap";

// Tab panels
import { AgentOverviewTab } from "@/components/agents/agent-overview-tab";
import { AgentInstructionsTab } from "@/components/agents/agent-instructions-tab";
import { AgentToolsTab } from "@/components/agents/agent-tools-tab";
import { AgentCredentialsTab } from "@/components/agents/agent-credentials-tab";
import { AgentConfigTab } from "@/components/agents/agent-config-tab";
import { AgentTasksTab } from "@/components/agents/agent-tasks-tab";
import { AgentMemoryTab } from "@/components/agents/agent-memory-tab";

// ── Breadcrumb ──

function AgentBreadcrumb() {
  const { state: { agent } } = useAgentDetail();
  const identity = agent.identity;

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
      <Link to="/agents" className="hover:text-foreground transition-colors">Agents</Link>
      <ChevronRight className="h-3 w-3" />
      <span className="text-foreground font-medium">{identity?.displayName ?? agent.name}</span>
    </div>
  );
}

// ── Left column sidebar ──

function AgentDetailSidebar() {
  return (
    <div className="w-80 shrink-0 hidden lg:flex flex-col gap-4 overflow-auto pb-bottom-nav lg:pb-0 pr-1">
      <AgentHeroCard />
      <AgentSocialsCard />
      <AgentHierarchyCard />
      <AgentPerformanceCard />
    </div>
  );
}

// ── Mobile identity summary (visible only on small screens) ──

function MobileIdentitySummary() {
  const { state: { agent, process }, actions: { refetch } } = useAgentDetail();
  const identity = agent.identity;

  return (
    <div className="lg:hidden mb-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <AgentAvatar avatar={identity?.avatar} name={agent.name} size="lg" iconClassName="text-primary" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold truncate">{identity?.displayName ?? agent.name}</h1>
            {process && <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />}
          </div>
          {identity?.title && <p className="text-xs text-muted-foreground">{identity.title}</p>}
          {agent.model && <p className="text-[10px] font-mono text-muted-foreground mt-0.5">{agent.model}</p>}
        </div>
        <Button variant="outline" size="sm" onClick={refetch} className="shrink-0 ml-auto">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ── Right column: activity + tabs ──

function AgentDetailContent() {
  const {
    state: { agent, process, taskStats, sortedTasks, enabledCategories, vaultEntries },
  } = useAgentDetail();

  return (
    <div className="flex-1 min-w-0 flex flex-col min-h-0">
      <MobileIdentitySummary />

      {/* Live activity */}
      {process && <LiveActivity process={process} />}

      {/* Activity heatmap */}
      {sortedTasks.length > 0 && (
        <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0 mb-3">
          <CardContent className="pt-3 pb-3 overflow-x-auto">
            <ActivityHeatmap tasks={sortedTasks} />
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="overview" className="flex flex-col flex-1 min-h-0 mt-2">
        <TabsList className="shrink-0">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="instructions">Instructions</TabsTrigger>
          <TabsTrigger value="tools">
            Tools & Skills
            <span className="text-muted-foreground font-normal ml-0.5">
              ({(agent.allowedTools?.length ?? 0) + enabledCategories.length + (agent.skills?.length ?? 0) + (agent.mcpServers ? Object.keys(agent.mcpServers).length : 0)})
            </span>
          </TabsTrigger>
          <TabsTrigger value="credentials">
            Credentials
            {vaultEntries.length > 0 && (
              <span className="text-muted-foreground font-normal ml-0.5">({vaultEntries.length})</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="memory">
            <Brain className="h-3.5 w-3.5 mr-1" />
            Memory
          </TabsTrigger>
          <TabsTrigger value="config">Config</TabsTrigger>
          <TabsTrigger value="tasks">
            Tasks
            {taskStats.total > 0 && (
              <span className="text-muted-foreground font-normal ml-0.5">({taskStats.total})</span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 flex-1 min-h-0">
          <AgentOverviewTab />
        </TabsContent>

        <TabsContent value="instructions" className="mt-4 flex-1 min-h-0">
          <AgentInstructionsTab />
        </TabsContent>

        <TabsContent value="tools" className="mt-4 flex-1 min-h-0">
          <AgentToolsTab />
        </TabsContent>

        <TabsContent value="credentials" className="mt-4 flex-1 min-h-0">
          <AgentCredentialsTab />
        </TabsContent>

        <TabsContent value="memory" className="mt-4 flex-1 min-h-0">
          <AgentMemoryTab />
        </TabsContent>

        <TabsContent value="config" className="mt-4 flex-1 min-h-0">
          <AgentConfigTab />
        </TabsContent>

        <TabsContent value="tasks" className="mt-4 flex-1 min-h-0">
          <AgentTasksTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Loading state ──

function AgentDetailLoading() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

// ── Error state ──

function AgentDetailError() {
  const { state: { error }, actions: { refetch } } = useAgentDetail();

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 bg-card/60 rounded-lg p-8">
      <Bot className="h-16 w-16 text-muted-foreground/30" />
      <p className="text-sm text-muted-foreground">
        {error ? `Error loading agent: ${error.message}` : "Agent not found"}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" asChild>
          <Link to="/agents"><ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back to Agents</Link>
        </Button>
        <Button variant="outline" size="sm" onClick={refetch}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Retry
        </Button>
      </div>
    </div>
  );
}

// ── Inner layout (reads context) ──

function AgentDetailInner() {
  const { state: { agent, isLoading, error } } = useAgentDetail();

  if (isLoading) return <AgentDetailLoading />;
  if (error || !agent) return <AgentDetailError />;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <AgentBreadcrumb />
      <div className="flex flex-1 min-h-0 gap-6">
        <AgentDetailSidebar />
        <AgentDetailContent />
      </div>
    </div>
  );
}

// ── Exported page (wraps everything in the provider) ──

export function AgentDetailPage() {
  return (
    <AgentDetailProvider>
      <AgentDetailInner />
    </AgentDetailProvider>
  );
}
