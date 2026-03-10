import { lazy, Suspense, useEffect, useState } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { AppLayout } from "@/components/layout/app-layout";
import { Loader2 } from "lucide-react";
import { config } from "@/lib/config";

// Lazy-load all pages for code splitting
const DashboardPage = lazy(() => import("@/pages/dashboard").then(m => ({ default: m.DashboardPage })));
const TasksPage = lazy(() => import("@/pages/tasks").then(m => ({ default: m.TasksPage })));
const TaskDetailPage = lazy(() => import("@/pages/task-detail").then(m => ({ default: m.TaskDetailPage })));
const MissionsPage = lazy(() => import("@/pages/missions").then(m => ({ default: m.MissionsPage })));
const MissionDetailPage = lazy(() => import("@/pages/mission-detail").then(m => ({ default: m.MissionDetailPage })));
const AgentsPage = lazy(() => import("@/pages/agents").then(m => ({ default: m.AgentsPage })));
const AgentDetailPage = lazy(() => import("@/pages/agent-detail").then(m => ({ default: m.AgentDetailPage })));
const ActivityPage = lazy(() => import("@/pages/activity").then(m => ({ default: m.ActivityPage })));
const ChatPage = lazy(() => import("@/pages/chat").then(m => ({ default: m.ChatPage })));
const MemoryPage = lazy(() => import("@/pages/memory").then(m => ({ default: m.MemoryPage })));

const NotificationsPage = lazy(() => import("@/pages/notifications").then(m => ({ default: m.NotificationsPage })));
const ApprovalsPage = lazy(() => import("@/pages/approvals").then(m => ({ default: m.ApprovalsPage })));
const PlaybooksPage = lazy(() => import("@/pages/playbooks").then(m => ({ default: m.PlaybooksPage })));
const PlaybookDetailPage = lazy(() => import("@/pages/playbook-detail").then(m => ({ default: m.PlaybookDetailPage })));
const ConfigPage = lazy(() => import("@/pages/config").then(m => ({ default: m.ConfigPage })));
const SkillsPage = lazy(() => import("@/pages/skills").then(m => ({ default: m.SkillsPage })));
const SkillDetailPage = lazy(() => import("@/pages/skill-detail").then(m => ({ default: m.SkillDetailPage })));
// Schedules are now integrated into the Missions page — redirect old URL for bookmarks

const FilesPage = lazy(() => import("@/pages/files").then(m => ({ default: m.FilesPage })));
const SetupPage = lazy(() => import("@/pages/setup").then(m => ({ default: m.SetupPage })));

// Check if server is in setup mode — blocks all rendering until resolved
function SetupModeRedirect({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<"loading" | "setup" | "ready">("loading");

  useEffect(() => {
    if (location.pathname === "/setup") {
      setState("ready");
      return;
    }
    setState("loading");
    fetch(`${config.baseUrl}/api/v1/config/status`)
      .then((r) => r.json())
      .then((r) => {
        if (r.ok && !r.data.initialized) {
          navigate("/setup", { replace: true });
          // Don't set ready — wait for location to change to /setup,
          // which re-triggers this effect and hits the early return above.
        } else {
          setState("ready");
        }
      })
      .catch(() => { setState("ready"); });
  }, [location.pathname]);

  // Block rendering until we know the mode — prevents dashboard API calls
  if (state === "loading") {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <>{children}</>;
}

function PageLoader() {
  return (
    <div className="flex items-center justify-center flex-1">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

export function App() {
  return (
    <SetupModeRedirect>
      <Routes>
        {/* Setup wizard — full-screen, no sidebar */}
        <Route path="setup" element={<Suspense fallback={<PageLoader />}><SetupPage /></Suspense>} />

        {/* Main app with sidebar layout */}
        <Route element={<AppLayout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Suspense fallback={<PageLoader />}><DashboardPage /></Suspense>} />
          <Route path="tasks" element={<Suspense fallback={<PageLoader />}><TasksPage /></Suspense>} />
          <Route path="tasks/:taskId" element={<Suspense fallback={<PageLoader />}><TaskDetailPage /></Suspense>} />
          <Route path="missions" element={<Suspense fallback={<PageLoader />}><MissionsPage /></Suspense>} />
          <Route path="missions/:missionId" element={<Suspense fallback={<PageLoader />}><MissionDetailPage /></Suspense>} />
          <Route path="agents" element={<Suspense fallback={<PageLoader />}><AgentsPage /></Suspense>} />
          <Route path="agents/:name" element={<Suspense fallback={<PageLoader />}><AgentDetailPage /></Suspense>} />
          <Route path="skills" element={<Suspense fallback={<PageLoader />}><SkillsPage /></Suspense>} />
          <Route path="skills/:skillName" element={<Suspense fallback={<PageLoader />}><SkillDetailPage /></Suspense>} />
          <Route path="activity" element={<Suspense fallback={<PageLoader />}><ActivityPage /></Suspense>} />
          <Route path="chat" element={<Suspense fallback={<PageLoader />}><ChatPage /></Suspense>} />
          <Route path="memory" element={<Suspense fallback={<PageLoader />}><MemoryPage /></Suspense>} />
          <Route path="logs" element={<Navigate to="/activity" replace />} />
          <Route path="notifications" element={<Suspense fallback={<PageLoader />}><NotificationsPage /></Suspense>} />
          <Route path="approvals" element={<Suspense fallback={<PageLoader />}><ApprovalsPage /></Suspense>} />
          <Route path="playbooks" element={<Suspense fallback={<PageLoader />}><PlaybooksPage /></Suspense>} />
          <Route path="playbooks/:name" element={<Suspense fallback={<PageLoader />}><PlaybookDetailPage /></Suspense>} />
          <Route path="schedules" element={<Navigate to="/missions" replace />} />
          <Route path="config" element={<Suspense fallback={<PageLoader />}><ConfigPage /></Suspense>} />
          <Route path="files" element={<Suspense fallback={<PageLoader />}><FilesPage /></Suspense>} />
        </Route>
      </Routes>
    </SetupModeRedirect>
  );
}
