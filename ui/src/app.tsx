import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { AppLayout } from "@/components/layout/app-layout";
import { Loader2 } from "lucide-react";

// Lazy-load all pages for code splitting
const DashboardPage = lazy(() => import("@/pages/dashboard").then(m => ({ default: m.DashboardPage })));
const TasksPage = lazy(() => import("@/pages/tasks").then(m => ({ default: m.TasksPage })));
const TaskDetailPage = lazy(() => import("@/pages/task-detail").then(m => ({ default: m.TaskDetailPage })));
const PlansPage = lazy(() => import("@/pages/plans").then(m => ({ default: m.PlansPage })));
const PlanDetailPage = lazy(() => import("@/pages/plan-detail").then(m => ({ default: m.PlanDetailPage })));
const AgentsPage = lazy(() => import("@/pages/agents").then(m => ({ default: m.AgentsPage })));
const AgentDetailPage = lazy(() => import("@/pages/agent-detail").then(m => ({ default: m.AgentDetailPage })));
const ActivityPage = lazy(() => import("@/pages/activity").then(m => ({ default: m.ActivityPage })));
const ChatPage = lazy(() => import("@/pages/chat").then(m => ({ default: m.ChatPage })));
const MemoryPage = lazy(() => import("@/pages/memory").then(m => ({ default: m.MemoryPage })));

const NotificationsPage = lazy(() => import("@/pages/notifications").then(m => ({ default: m.NotificationsPage })));
const ApprovalsPage = lazy(() => import("@/pages/approvals").then(m => ({ default: m.ApprovalsPage })));
const TemplatesPage = lazy(() => import("@/pages/templates").then(m => ({ default: m.TemplatesPage })));
const ConfigPage = lazy(() => import("@/pages/config").then(m => ({ default: m.ConfigPage })));

function PageLoader() {
  return (
    <div className="flex items-center justify-center flex-1">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Suspense fallback={<PageLoader />}><DashboardPage /></Suspense>} />
        <Route path="tasks" element={<Suspense fallback={<PageLoader />}><TasksPage /></Suspense>} />
        <Route path="tasks/:taskId" element={<Suspense fallback={<PageLoader />}><TaskDetailPage /></Suspense>} />
        <Route path="plans" element={<Suspense fallback={<PageLoader />}><PlansPage /></Suspense>} />
        <Route path="plans/:planId" element={<Suspense fallback={<PageLoader />}><PlanDetailPage /></Suspense>} />
        <Route path="agents" element={<Suspense fallback={<PageLoader />}><AgentsPage /></Suspense>} />
        <Route path="agents/:name" element={<Suspense fallback={<PageLoader />}><AgentDetailPage /></Suspense>} />
        <Route path="activity" element={<Suspense fallback={<PageLoader />}><ActivityPage /></Suspense>} />
        <Route path="chat" element={<Suspense fallback={<PageLoader />}><ChatPage /></Suspense>} />
        <Route path="memory" element={<Suspense fallback={<PageLoader />}><MemoryPage /></Suspense>} />
        <Route path="logs" element={<Navigate to="/activity" replace />} />
        <Route path="notifications" element={<Suspense fallback={<PageLoader />}><NotificationsPage /></Suspense>} />
        <Route path="approvals" element={<Suspense fallback={<PageLoader />}><ApprovalsPage /></Suspense>} />
        <Route path="templates" element={<Suspense fallback={<PageLoader />}><TemplatesPage /></Suspense>} />
        <Route path="config" element={<Suspense fallback={<PageLoader />}><ConfigPage /></Suspense>} />
      </Route>
    </Routes>
  );
}
