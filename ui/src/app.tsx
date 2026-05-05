import { lazy, Suspense, useEffect, useState } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { PolpoProvider } from "@polpo-ai/react";
import { AppLayout } from "@/components/layout/app-layout";
import { Loader2 } from "lucide-react";
import { config } from "@/lib/config";
import { ChatProvider } from "@/hooks/chat-context";

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
const BrowserPage = lazy(() => import("@/pages/browser").then(m => ({ default: m.BrowserPage })));
const SetupPage = lazy(() => import("@/pages/setup").then(m => ({ default: m.SetupPage })));
const LoginPage = lazy(() => import("@/pages/login").then(m => ({ default: m.LoginPage })));

// Check if server is in setup mode — blocks all rendering until resolved
function SetupModeRedirect({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [state, setState] = useState<"loading" | "ready">("loading");
  const [message, setMessage] = useState("Connecting to Polpo...");
  const [redirectTo, setRedirectTo] = useState<string | null>(null);

  const loginPath = () => {
    const next = `${location.pathname}${location.search}${location.hash}`;
    return `/login?next=${encodeURIComponent(next === "/" ? "/chat" : next)}`;
  };

  // Keep the bootstrap gate alive until the server answers. In hosted deploys the
  // UI container can become reachable before the server container; giving up on
  // the first failed status call drops users into the app with a permanent
  // "Connecting..." sidebar instead of routing them to setup/login.
  useEffect(() => {
    if (location.pathname === "/setup" || location.pathname === "/login") {
      setRedirectTo(null);
      setState("ready");
      return;
    }

    let cancelled = false;
    let retry: number | undefined;
    let attempt = 0;

    const check = async () => {
      try {
        const res = await fetch(`${config.baseUrl}/api/v1/config/status`, { credentials: "include" });
        const r = await res.json();
        if (cancelled) return;

        if (!r?.ok) {
          throw new Error(r?.error || "Could not read setup status.");
        }

        const auth = r.data?.auth;
        if (!r.data?.initialized || (auth?.enabled && !auth.configured)) {
          setRedirectTo("/setup");
          setState("ready");
          return;
        }

        if (auth?.enabled) {
          const authStatus = await fetch(`${config.baseUrl}/api/v1/auth/instance/status`, { credentials: "include" })
            .then((res) => res.json())
            .catch(() => null);
          if (cancelled) return;
          if (authStatus?.ok && !authStatus.data.authenticated) {
            setRedirectTo(loginPath());
            setState("ready");
            return;
          }
          if (!authStatus?.ok) {
            setRedirectTo(loginPath());
            setState("ready");
            return;
          }
        }
        setRedirectTo(null);
        setState("ready");
      } catch {
        if (cancelled) return;
        attempt += 1;
        setMessage(attempt > 4 ? "Still waiting for the Polpo server..." : "Connecting to Polpo...");
        retry = window.setTimeout(check, Math.min(500 * attempt, 2500));
      }
    };

    check();

    return () => {
      cancelled = true;
      if (retry) window.clearTimeout(retry);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.search, location.hash]);

  // Block rendering only during the initial setup check
  if (state === "loading") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    );
  }

  if (redirectTo) {
    return <Navigate to={redirectTo} replace />;
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

function AuthenticatedApp() {
  return (
    <PolpoProvider
      baseUrl={config.baseUrl}
      apiKey={config.apiKey}
    >
      <ChatProvider>
        <AppLayout />
      </ChatProvider>
    </PolpoProvider>
  );
}

export function App() {
  return (
    <SetupModeRedirect>
      <Routes>
        {/* Setup wizard — full-screen, no sidebar */}
        <Route path="setup" element={<Suspense fallback={<PageLoader />}><SetupPage /></Suspense>} />
        <Route path="login" element={<Suspense fallback={<PageLoader />}><LoginPage /></Suspense>} />

        {/* Main app with sidebar layout */}
        <Route element={<AuthenticatedApp />}>
          <Route index element={<Navigate to="/chat" replace />} />
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
 <Route path="browser" element={<Suspense fallback={<PageLoader />}><BrowserPage /></Suspense>} />
        </Route>
      </Routes>
    </SetupModeRedirect>
  );
}
