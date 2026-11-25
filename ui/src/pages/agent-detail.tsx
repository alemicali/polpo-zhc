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

import { useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
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
  Monitor,
  FlaskConical,
  FlaskRound,
} from "lucide-react";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { AgentModelWithEngine } from "@/components/shared/model-with-engine";
// Provider + context hook
import { AgentDetailProvider } from "@/components/agents/agent-detail-provider";
import { useAgentDetail } from "@/components/agents/agent-detail-context";
import { cn } from "@/lib/utils";

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
import { AgentComputerTab } from "@/components/agents/agent-computer-tab";
import { AgentSandboxTab } from "@/components/agents/agent-sandbox-tab";
import { AgentLearningTab } from "@/components/agents/agent-learning-tab";
import { AgentDriveTab } from "@/components/agents/agent-drive-tab";
import { AgentTasksTab } from "@/components/agents/agent-tasks-tab";
import { AgentMemoryTab } from "@/components/agents/agent-memory-tab";
import { AgentVersionsTab, AgentVersionBadges } from "@/components/agents/agent-versions-tab";
import { AgentTestsTab } from "@/components/agents/agent-tests-tab";
import { AgentSuitesTab } from "@/components/agents/agent-suites-tab";

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
    // Scrolls on its own, vertically only (long values are truncated, never scrolled sideways), and
    // keeps room at the bottom so the last card is reachable on short viewports.
    <div
      className="w-80 shrink-0 hidden lg:flex min-h-0 flex-col gap-4 overflow-y-auto overflow-x-hidden pb-4 pr-1"
      data-testid="agent-detail-sidebar"
    >
      <AgentHeroCard />
      <AgentSocialsCard />
      <AgentHierarchyCard />
      <AgentPerformanceCard />
    </div>
  );
}

// ── Mobile identity summary (visible only on small screens) ──

function MobileIdentitySummary() {
  const { state: { agent, process, isRefreshing }, actions: { refetch } } = useAgentDetail();
  const identity = agent.identity;

  return (
    <div className="lg:hidden mb-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <AgentAvatar avatar={identity?.avatar} name={agent.name} size="lg" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="font-heading text-h2 truncate">{identity?.displayName ?? agent.name}</h1>
            {process && <div className="h-2 w-2 rounded-pill bg-primary animate-pulse" />}
          </div>
          {identity?.title && <p className="text-xs text-muted-foreground">{identity.title}</p>}
          <AgentVersionBadges agent={agent} className="mt-1" />
          <p className="mt-0.5 flex min-w-0 text-micro text-muted-foreground"><AgentModelWithEngine agent={agent} mono size={12} testId="agent-mobile-model" /></p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refetch}
          disabled={isRefreshing}
          className="shrink-0 ml-auto"
          aria-label={isRefreshing ? "Refreshing agent" : "Refresh agent"}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
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
  // ?tab=credentials opens a tab directly (e.g. from a vault picker's "add it" link, or the
  // Sandbox tab's "manage in the Computer tab"); switching tabs keeps it in the URL.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") ?? "overview";
  const selectTab = (value: string) => setSearchParams((params) => {
    const next = new URLSearchParams(params);
    next.set("tab", value);
    return next;
  }, { replace: true });

  // The right column is ONE scroll container: the activity strip scrolls away, the tab bar sticks
  // to its top and every tab panel is plain flow content (no nested scrollers, no clipping
  // overflow-hidden ancestor). On a tab change, if the reader had scrolled past the tab bar, the
  // new tab starts at its top (just under the sticky bar).
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const lastTab = useRef(tab);
  useEffect(() => {
    if (lastTab.current === tab) return;
    lastTab.current = tab;
    const scroller = scrollRef.current;
    const tabs = tabsRef.current;
    if (!scroller || !tabs) return;
    const offset = tabs.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    if (offset < 0) scroller.scrollTop += offset;
  }, [tab]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
      data-testid="agent-detail-scroll"
    >
      <MobileIdentitySummary />

      {/* Live activity */}
      {process && <LiveActivity process={process} />}

      {/* Activity heatmap */}
      {sortedTasks.length > 0 && (
        <Card className="py-0 gap-0 mb-3 shrink-0">
          <CardContent className="pt-3 pb-3 overflow-x-auto">
            <ActivityHeatmap tasks={sortedTasks} />
          </CardContent>
        </Card>
      )}

      <Tabs ref={tabsRef} value={tab} onValueChange={selectTab} className="mt-2 flex min-w-0 flex-col gap-0">
        {/* Sticky tab bar: page background so the content passes under it; it scrolls sideways on
            its own when the tabs don't fit the column. */}
        <div
          className="sticky top-0 z-10 shrink-0 overflow-x-auto bg-background pb-2"
          data-testid="agent-detail-tabbar"
        >
        <TabsList className="shrink-0">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="instructions">Instructions</TabsTrigger>
          <TabsTrigger value="tools">
            Tools & Skills
            <span className="text-muted-foreground font-normal ml-0.5">
              ({(agent.allowedTools?.length ?? 0) + enabledCategories.length + (agent.skills?.length ?? 0)})
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
          <TabsTrigger value="learning">Learning</TabsTrigger>
          <TabsTrigger value="goals">Goals</TabsTrigger>
          <TabsTrigger value="computer">
            <Monitor className="h-3.5 w-3.5 mr-1" />
            Computer
          </TabsTrigger>
          <TabsTrigger value="sandbox">Sandbox</TabsTrigger>
          <TabsTrigger value="config">Config</TabsTrigger>
          <TabsTrigger value="versions">
            <span className="inline-flex items-center gap-1.5">
              Versions
              {agent.versioning?.draft.hasChanges && <span className="h-1.5 w-1.5 rounded-pill bg-warning" aria-label="Draft has changes" />}
            </span>
          </TabsTrigger>
          <TabsTrigger value="tests">
            <FlaskConical className="h-3.5 w-3.5 mr-1" />
            Tests
          </TabsTrigger>
          <TabsTrigger value="suites">
            <FlaskRound className="h-3.5 w-3.5 mr-1" />
            Suites
          </TabsTrigger>
          <TabsTrigger value="tasks">
            Tasks
            {taskStats.total > 0 && (
              <span className="text-muted-foreground font-normal ml-0.5">({taskStats.total})</span>
            )}
          </TabsTrigger>
        </TabsList>
        </div>

        <TabsContent value="overview" className="mt-2 min-w-0 flex-none">
          <AgentOverviewTab />
        </TabsContent>

        <TabsContent value="instructions" className="mt-2 min-w-0 flex-none">
          <AgentInstructionsTab />
        </TabsContent>

        <TabsContent value="tools" className="mt-2 min-w-0 flex-none">
          <AgentToolsTab />
        </TabsContent>

        <TabsContent value="credentials" className="mt-2 min-w-0 flex-none">
          <AgentCredentialsTab />
        </TabsContent>

        <TabsContent value="memory" className="mt-2 min-w-0 flex-none">
          <AgentMemoryTab />
        </TabsContent>

        <TabsContent value="learning" className="mt-2 min-w-0 flex-none">
          <AgentLearningTab />
        </TabsContent>

        <TabsContent value="goals" className="mt-2 min-w-0 flex-none">
          <AgentDriveTab />
        </TabsContent>

        <TabsContent value="computer" className="mt-2 min-w-0 flex-none">
          <AgentComputerTab />
        </TabsContent>

        <TabsContent value="sandbox" className="mt-2 min-w-0 flex-none">
          <AgentSandboxTab />
        </TabsContent>

        <TabsContent value="versions" className="mt-2 min-w-0 flex-none">
          <AgentVersionsTab />
        </TabsContent>
        <TabsContent value="config" className="mt-2 min-w-0 flex-none">
          <AgentConfigTab />
        </TabsContent>

        <TabsContent value="tests" className="mt-2 min-w-0 flex-none">
          <AgentTestsTab />
        </TabsContent>
        <TabsContent value="suites" className="mt-2 min-w-0 flex-none">
          <AgentSuitesTab />
        </TabsContent>

        <TabsContent value="tasks" className="mt-2 min-w-0 flex-none">
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
  const { state: { error, isRefreshing }, actions: { refetch } } = useAgentDetail();

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
        <Button variant="outline" size="sm" onClick={refetch} disabled={isRefreshing}>
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1", isRefreshing && "animate-spin")} />
          {isRefreshing ? "Retrying" : "Retry"}
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
    <div className="flex flex-col flex-1 min-h-0 min-w-0 gap-4">
      <AgentBreadcrumb />
      <div className="flex flex-1 min-h-0 min-w-0 gap-6">
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
