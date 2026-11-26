/** The page names the header shows (and the browser tab carries after the product name). */
const titles: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/missions": "Missions",
  "/tasks": "Tasks",
  "/agents": "Agents",
  "/connectors": "Connectors",
  "/agent-talk": "Agent conversations",
  "/benchmarks": "Benchmarks",
  "/playground": "Playground",
  "/skills": "Skills",
  "/events": "Events",
  "/chat": "Chat",
  "/memory": "Memory",
  "/notifications": "Notifications",
  "/approvals": "Approvals",
  "/triggers": "Triggers",
  "/decisions": "Decisions",
  "/playbooks": "Playbooks",
  "/files": "Files",
  "/config": "Configuration",
  "/apps": "Apps",
  "/data": "Data",
  "/artifacts": "Artifacts",
  "/brain": "Company Brain",
  "/changelog": "Novità",
};

export function resolveTitle(pathname: string): string {
  if (titles[pathname]) return titles[pathname];
  if (pathname.startsWith("/missions/")) return "Mission Detail";
  if (pathname.startsWith("/tasks/")) return "Task Detail";
  if (pathname.startsWith("/agents/")) return "Agent Detail";
  if (pathname.startsWith("/skills/")) return "Skill Detail";
  return "";
}
