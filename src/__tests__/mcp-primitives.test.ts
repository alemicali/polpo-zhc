/**
 * The MCP tools for the instance's primitives (team, rooms, chat sessions, memory, skills, automation,
 * connectors, channels, vault, brain, learning, watchers, apps), against a fake API.
 */
import { describe, expect, it, vi } from "vitest";
import { handleMcpRequest, type ApiResponse, type McpDeps } from "../server/mcp.js";
import { expectValidOutput } from "./helpers/mcp-output.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const SECRET = "sk-live-super-secret-value-123";

type Msg = { id: string; ts: string; authorKind: string; authorId: string; authorName: string; text: string; replyToId?: string; addressedTo?: string[] };

function fakeInstance() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}): ApiResponse => ({ status, body, headers: new Headers(headers) });
  // a copy, as the real API serializes its answers
  const okData = (data: unknown, status = 200) => reply(status, { ok: true, data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)) });
  const notFound = (what: string) => reply(404, { ok: false, error: `${what} not found`, code: "NOT_FOUND" });
  let seq = 0;
  const now = () => new Date(Date.UTC(2026, 10, 21, 10, 0, ++seq)).toISOString();

  const agents = [
    { name: "coach", role: "Health coach", team: "main" },
    { name: "writer", role: "Writer", team: "main" },
  ];
  const teams = [{ name: "main", agents: ["coach", "writer"] as string[] }, { name: "empty", agents: [] as string[] }];
  let settings: Record<string, unknown> = { notifications: { channels: { ops: { type: "telegram", botToken: "••••oken" } }, rules: [{ id: "r1", name: "Failures", events: ["task:failed"], channels: ["ops"] }] } };
  const rooms = new Map<string, { id: string; kind: string; title: string; agents: string[]; settings: Record<string, unknown> }>([
    ["web:1", { id: "web:1", kind: "web", title: "Launch", agents: ["coach", "writer"], settings: { goal: "Ship it" } }],
    ["telegram:group:-1", { id: "telegram:group:-1", kind: "telegram", title: "TG", agents: ["coach"], settings: {} }],
  ]);
  const roomMessages = new Map<string, Msg[]>([["web:1", Array.from({ length: 35 }, (_, i) => ({ id: `m${i + 1}`, ts: now(), authorKind: i % 2 ? "agent" : "person", authorId: i % 2 ? "coach" : "web:user", authorName: i % 2 ? "coach" : "Ada", text: `message ${i + 1}` }))]]);
  let typing: Array<{ agent: string; name: string }> = [];
  const sessions = [
    { id: "s1", title: "Weekly plan", agent: "coach", createdAt: now(), updatedAt: now(), messageCount: 3, starred: false },
    { id: "s2", title: "Polpo chat", createdAt: now(), updatedAt: now(), messageCount: 25 },
  ];
  const sessionMessages = Array.from({ length: 25 }, (_, i) => ({ id: `cm${i + 1}`, role: i % 2 ? "assistant" : "user", ts: now(), content: `text ${i + 1}`,
    ...(i === 3 ? { toolCalls: [{ name: "set_vault_entry", arguments: { credentials: { password: "[REDACTED]" } } }] } : {}) }));
  const memory: Record<string, string> = { shared: "We ship on Fridays.", coach: "" };
  const skills = [
    { name: "weekly-report", description: "Write the weekly report", source: "project", assignedTo: ["writer"], tags: ["report"] },
    { name: "global-one", description: "Global helper", source: "global", assignedTo: [] as string[] },
  ];
  const schedules = [{ id: "sched-m1", missionId: "m1", expression: "0 9 * * 1-5", recurring: true, enabled: true, nextRunAt: "2026-11-24T09:00:00.000Z" }];
  const checks: Array<Record<string, unknown>> = [];
  const connectors = new Map<string, Record<string, unknown>>([
    ["linear", { id: "linear", name: "Linear", kind: "mcp", transport: { type: "http", url: `https://mcp.linear.app/mcp?key=${SECRET}` }, auth: { type: "oauth" }, access: { agents: ["coach"], polpo: true }, enabled: true, status: "connected", toolCount: 12, secrets: { bearerToken: false, headers: [], clientSecret: false, values: [], oauth: { authorized: true } } }],
  ]);
  const watchers: Array<Record<string, unknown>> = [];
  const vault: Record<string, Array<Record<string, unknown>>> = {
    coach: [{ service: "gmail", type: "smtp", label: "Mail", keys: ["host", "user", "password"], password: SECRET }, { service: "shared-api", type: "api_key", keys: ["key"], sharedFrom: "writer", readOnly: true }],
    writer: [],
  };

  const api: McpDeps["api"] = vi.fn(async (method, path, body) => {
    calls.push({ method, path, body });
    const url = new URL(path, "http://x");
    const p = url.pathname.replace(/^\/api\/v1/, "");
    const q = url.searchParams;
    let m: RegExpMatchArray | null;
    // agents and teams
    if (p === "/agents" && method === "GET") return okData(agents);
    if (p === "/agents/teams" && method === "GET") return okData(teams.map((t) => ({ name: t.name, agents: t.agents.map((name) => ({ name, systemPrompt: "secret prompt" })) })));
    if (p === "/agents/teams" && method === "POST") { teams.push({ name: (body as { name: string }).name, agents: [] }); return okData({ added: true }, 201); }
    if (p === "/agents/team" && method === "PATCH") { const b = body as { oldName: string; name: string }; teams.find((t) => t.name === b.oldName)!.name = b.name; return okData({}); }
    if ((m = p.match(/^\/agents\/teams\/([^/]+)$/)) && method === "DELETE") { const i = teams.findIndex((t) => t.name === decodeURIComponent(m![1]!)); if (i < 0) return notFound("Team"); teams.splice(i, 1); return okData({ removed: true }); }
    if ((m = p.match(/^\/agents\/([^/]+)\/avatar$/))) {
      if (method === "POST") { const f = (body as FormData).get("file") as File; return okData({ avatar: `.polpo/avatars/${m[1]}.png`, type: f.type }); }
      return reply(200, { ok: true });
    }
    if ((m = p.match(/^\/agents\/([^/]+)$/))) {
      const a = agents.find((x) => x.name === decodeURIComponent(m![1]!));
      if (!a) return notFound("Agent");
      if (method === "DELETE") { agents.splice(agents.indexOf(a), 1); return okData({ removed: true }); }
      if (method === "PATCH") {
        const b = body as { team?: string };
        if (b.team) { for (const t of teams) t.agents = t.agents.filter((x) => x !== a.name); teams.find((t) => t.name === b.team)!.agents.push(a.name); }
        Object.assign(a, body); return okData(a);
      }
      return okData(a);
    }
    if (p === "/config" && method === "GET") return okData({ project: "demo", settings });
    if (p === "/config/settings" && method === "PATCH") { settings = { ...settings, ...(body as object) }; return okData({ settings }); }
    // rooms
    if (p === "/rooms" && method === "GET") return okData([...rooms.values()].filter((r) => !q.get("kind") || r.kind === q.get("kind")));
    if (p === "/rooms" && method === "POST") {
      const b = body as { title: string; agents: string[]; settings?: Record<string, unknown> };
      if (b.agents.some((a) => !agents.some((x) => x.name === a))) return reply(400, { ok: false, error: `Unknown agents: ${b.agents.join(", ")}` });
      const room = { id: `web:${rooms.size + 1}`, kind: "web", title: b.title, agents: b.agents, settings: b.settings ?? {} };
      rooms.set(room.id, room);
      return okData(room, 201);
    }
    if ((m = p.match(/^\/rooms\/([^/]+)(\/[a-z]+)?$/))) {
      const room = rooms.get(decodeURIComponent(m[1]!));
      if (!room) return notFound("Room");
      const action = m[2];
      if (!action && method === "GET") return okData(room);
      if (!action && method === "PATCH") { const b = body as Record<string, unknown>; Object.assign(room, { ...b, settings: { ...room.settings, ...(b.settings as object ?? {}) } }); return okData(room); }
      if (!action && method === "DELETE") { rooms.delete(room.id); return okData({ deleted: true }); }
      if (action === "/typing") return okData(typing);
      if (action === "/messages" && method === "GET") return okData(roomMessages.get(room.id) ?? []);
      if (action === "/messages" && method === "POST") {
        const b = body as { text: string; name?: string; replyToId?: string };
        const msg: Msg = { id: `m${(roomMessages.get(room.id) ?? []).length + 1}`, ts: now(), authorKind: "person", authorId: "web:user", authorName: b.name ?? "You", text: b.text, ...(b.replyToId ? { replyToId: b.replyToId } : {}), addressedTo: [...b.text.matchAll(/@([a-z]+)/g)].map((x) => x[1]!) };
        const list = roomMessages.get(room.id) ?? [];
        list.push(msg);
        roomMessages.set(room.id, list);
        // the agent answers "in the background": typing now, its reply at the next look
        typing = [{ agent: "coach", name: "coach" }];
        setTimeout(() => { list.push({ id: `m${list.length + 1}`, ts: now(), authorKind: "agent", authorId: "coach", authorName: "coach", text: "On it", replyToId: msg.id }); typing = []; }, 15);
        return okData(msg, 201);
      }
    }
    // chat sessions
    if (p === "/chat/sessions" && method === "GET") return okData({ sessions });
    if ((m = p.match(/^\/chat\/sessions\/([^/]+)(\/messages)?$/))) {
      const s = sessions.find((x) => x.id === m![1]);
      if (!s) return notFound("Session");
      if (m[2]) return okData({ session: s, messages: sessionMessages, incremental: false });
      if (method === "PATCH") { Object.assign(s, body); return okData({ renamed: true }); }
      if (method === "DELETE") { sessions.splice(sessions.indexOf(s), 1); return okData({ deleted: true }); }
    }
    // memory
    if (p === "/memory") { if (method === "PUT") memory.shared = (body as { content: string }).content; return okData({ exists: true, content: memory.shared }); }
    if ((m = p.match(/^\/memory\/agent\/([^/]+)$/))) {
      if (!(m[1]! in memory)) return notFound("Agent");
      if (method === "PUT") memory[m[1]!] = (body as { content: string }).content;
      return okData({ exists: !!memory[m[1]!], content: memory[m[1]!], agent: m[1] });
    }
    // skills
    if (p === "/skills" && method === "GET") return okData(skills);
    if (p === "/skills/create") {
      const b = body as { name: string; description: string };
      if (skills.some((s) => s.name === b.name)) return reply(409, { ok: false, error: "exists", code: "CONFLICT" });
      skills.push({ name: b.name, description: b.description, source: "project", assignedTo: [] });
      return okData({ name: b.name, path: "/x" }, 201);
    }
    if (p === "/skills/add") return (body as { source: string }).source === "bad/repo"
      ? reply(400, { ok: false, data: { installed: [], skipped: [], errors: ["repository not found"] } })
      : reply(201, { ok: true, data: { installed: [{ name: "pdf", path: "/x" }], skipped: [{ name: "weekly-report" }], errors: [] } });
    if ((m = p.match(/^\/skills\/([^/]+)(\/[a-z]+)?$/))) {
      const s = skills.find((x) => x.name === decodeURIComponent(m![1]!));
      if (!s) return notFound("Skill");
      const action = m[2];
      if (action === "/content") return okData({ ...s, content: "# Steps\n1. Do it", path: "/abs/secret/path" });
      if (action === "/assign") { s.assignedTo.push((body as { agent: string }).agent); return okData({}); }
      if (action === "/unassign") { s.assignedTo = s.assignedTo.filter((a) => a !== (body as { agent: string }).agent); return okData({}); }
      if (action === "/index") { Object.assign(s, body); return okData({ skill: s.name }); }
      if (!action && method === "PUT") { Object.assign(s, body); return okData({ name: s.name, updated: true }); }
      if (!action && method === "DELETE") { skills.splice(skills.indexOf(s), 1); return okData({ removed: s.name }); }
    }
    // schedules, missions, tasks
    if (p === "/missions" && method === "GET") return okData([{ id: "m1", name: "Daily digest", status: "recurring" }]);
    if (p === "/tasks" && method === "GET") return okData([{ id: "t1", title: "Digest", status: "done", missionId: "m1", assignTo: "writer", updatedAt: now() }, { id: "t2", title: "Other", status: "done", updatedAt: now() }]);
    if (p === "/schedules" && method === "GET") return okData(schedules);
    if (p === "/schedules" && method === "POST") {
      const b = body as { missionId: string; expression: string; recurring?: boolean };
      if (b.missionId !== "m2") return notFound("Mission");
      if (b.expression === "nope") return reply(400, { ok: false, error: "Could not create schedule. Expression may be invalid", code: "INVALID_EXPRESSION" });
      const s = { id: `sched-${b.missionId}`, missionId: b.missionId, expression: b.expression, recurring: !!b.recurring, enabled: true };
      schedules.push(s as never);
      return okData(s, 201);
    }
    if ((m = p.match(/^\/schedules\/([^/]+)(\/run)?$/))) {
      const s = schedules.find((x) => x.missionId === m![1]);
      if (!s) return notFound("Schedule");
      if (m[2]) { Object.assign(s, { lastRunAt: now() }); return okData(s); }
      if (method === "PATCH") { Object.assign(s, body); return okData(s); }
      if (method === "DELETE") { schedules.splice(schedules.indexOf(s), 1); return okData({ deleted: true }); }
    }
    // checks
    if (p === "/checks" && method === "GET") return okData(checks.filter((c) => !q.get("state") || c.state === q.get("state")));
    if (p === "/checks" && method === "POST") {
      const b = body as Record<string, unknown>;
      const c = { id: `chk${checks.length + 1}`, sessionId: b.sessionId ?? "new-session", prompt: b.prompt ?? "", ...(b.message ? { message: b.message } : {}), everyMinutes: b.everyMinutes ?? 0, ...(b.cron ? { cron: b.cron } : {}), state: "active", nextRunAt: "2026-11-21T11:00:00.000Z", runs: 0, ...(b.agent ? { agent: b.agent } : {}), createdBy: b.createdBy };
      checks.push(c);
      return okData(c, 201);
    }
    if ((m = p.match(/^\/checks\/([^/]+)$/))) {
      const c = checks.find((x) => x.id === m![1]);
      if (!c) return notFound("Check");
      if (method === "DELETE" && q.get("purge") === "true") { checks.splice(checks.indexOf(c), 1); return okData({ ...c, deleted: true }); }
      if (method === "DELETE") { c.state = "cancelled"; return okData(c); }
      const b = body as Record<string, unknown>;
      if (b.confirm) c.state = "active";
      Object.assign(c, Object.fromEntries(Object.entries(b).filter(([k]) => k !== "confirm")));
      return okData(c);
    }
    // connectors
    if (p === "/connectors" && method === "GET") return okData({ connectors: [...connectors.values()] });
    if (p === "/connectors/catalog") return okData({
      entries: [
        { id: "notion", name: "Notion", category: "Productivity", description: "Notes and docs", url: "https://mcp.notion.com/mcp", transport: "http", auth: "oauth" },
        { id: "stripe", name: "Stripe", category: "Payments", description: "Payments", url: "https://mcp.stripe.com", transport: "http", auth: "bearer" },
        { id: "azure", name: "Azure DevOps", category: "Dev", description: "Boards", urlTemplate: "https://mcp.dev.azure.com/{organization}", transport: "http", auth: "oauth" },
      ],
      oauthApps: [],
    });
    if (p === "/connectors" && method === "POST") {
      const b = body as { catalogId?: string; url?: string; name?: string; auth?: { type: string }; access?: { agents?: string[] }; transport?: { type: string } };
      const id = b.catalogId ?? "custom";
      const authType = b.catalogId === "stripe" ? "bearer" : b.catalogId ? "oauth" : b.auth?.type ?? "none";
      const c = { id, name: b.name ?? id, kind: "mcp", transport: { type: b.transport?.type ?? "http", url: b.url ?? `https://${id}.example.com/mcp` }, auth: { type: authType }, access: { agents: b.access?.agents ?? [], polpo: true }, enabled: true, status: authType === "oauth" ? "needs_auth" : "disconnected", secrets: { bearerToken: false, headers: [], clientSecret: false, values: [], oauth: { authorized: false } } };
      connectors.set(id, c);
      return okData(c, 201);
    }
    if ((m = p.match(/^\/connectors\/([^/]+)(\/[a-z/]+)?$/))) {
      const c = connectors.get(m[1]!);
      if (!c) return notFound("Connector");
      const action = m[2];
      if (!action && method === "GET") return okData(c);
      if (!action && method === "PATCH") { Object.assign(c, body); return okData(c); }
      if (!action && method === "DELETE") { connectors.delete(c.id as string); return okData({ removed: true }); }
      if (action === "/tools") return okData({ tools: [{ name: "create_issue", description: "Create an issue", policy: "allow" }, { name: "delete_issue", policy: "off" }] });
      if (action === "/oauth/start") return okData({ authorizationUrl: `https://auth.example.com/authorize?state=abc&c=${c.id}` });
      if (action === "/test") return okData(c.auth && (c.auth as { type: string }).type === "none" ? { ok: true, status: "connected", tools: [{ name: "ping" }], connector: c } : { ok: false, status: "needs_auth", error: "Not authorized" });
      if (action === "/disconnect") { c.status = "needs_auth"; return okData(c); }
    }
    // channels and sending
    if (p === "/telegram/chats") return okData({ bots: [{ key: "ops", agent: undefined }], chats: [{ id: "telegram:group:-100", kind: "group", name: "Team" }] });
    if (p === "/telegram/send") return okData({ sent: true, bot: "ops", to: { chatId: "-100", name: "Team" } });
    if (p === "/whatsapp/profiles") return okData({ profiles: [{ profileDir: "default", status: "authenticated", path: "/abs" }] });
    if (p === "/whatsapp/send") return okData({ id: "wa1", jid: "39333@s.whatsapp.net" });
    if (p === "/email/send") return okData({ id: "<mail1@x>" });
    if ((m = p.match(/^\/config\/channels\/([^/]+)\/test$/))) return m[1] === "ops" ? okData({ success: true }) : reply(404, { ok: false, error: "not found" });
    if ((m = p.match(/^\/config\/rules\/([^/]+)$/))) {
      const rules = (settings.notifications as { rules: Array<{ id: string }> }).rules;
      if (method === "PUT") { const i = rules.findIndex((r) => r.id === m![1]); if (i < 0) rules.push(body as never); else rules[i] = body as never; return okData({}); }
      if (method === "DELETE") { const i = rules.findIndex((r) => r.id === m![1]); if (i < 0) return reply(404, { ok: false, error: "Rule not found" }); rules.splice(i, 1); return okData({}); }
    }
    // vault
    if ((m = p.match(/^\/vault\/entries\/([^/]+)(?:\/([^/]+))?$/))) {
      const list = vault[m[1]!];
      if (!list) return okData([]);
      if (method === "DELETE") { const i = list.findIndex((e) => e.service === m![2]); if (i >= 0) list.splice(i, 1); return okData({ removed: i >= 0 }); }
      return okData(list);
    }
    // brain
    if (p === "/brain/search") return okData([{ id: "e1", type: "company", name: "Acme", summary: "A customer", score: 3 }]);
    if (p === "/brain/graph") return okData({ entities: [{ id: "e1", type: "company", name: "Acme" }, { id: "e2", type: "person", name: "Ada" }], stats: { entities: 2 } });
    if (p === "/brain/entities/e1") return okData({ entity: { id: "e1", type: "company", name: "Acme" }, relations: [{ id: "r1", fromId: "e2", toId: "e1", type: "works_at" }], claims: [{ id: "c1", predicate: "revenue", value: 10 }] });
    if (p === "/brain/entities" && method === "POST") return okData({ id: "e3", ...(body as object) }, 201);
    if ((m = p.match(/^\/brain\/(entities|relations|claims)\/([^/]+)$/)) && method === "DELETE") return m[2] === "e1" ? reply(200, { ok: true }) : reply(404, { ok: false, error: "Brain entity not found" });
    // learning
    if ((m = p.match(/^\/learning\/([^/]+)(\/review|\/changes\/[^/]+\/revert)?$/))) {
      if (!agents.some((a) => a.name === m![1])) return notFound("Agent");
      if (m[2] === "/review") return okData({ changes: [{ id: "lc1", kind: "memory", summary: "Remembered the user's goals" }] });
      if (m[2]) return okData({ change: { id: "lc0", reverted: true } });
      return okData({ learning: { enabled: true }, changes: [{ id: "lc0", kind: "skill", summary: "Made a skill" }] });
    }
    // watchers
    if (p === "/watchers" && method === "GET") return okData(watchers);
    if (p === "/watchers" && method === "POST") { const w = { id: `w${watchers.length + 1}`, ...(body as object), fired: false }; watchers.push(w); return okData(w, 201); }
    if ((m = p.match(/^\/watchers\/([^/]+)$/))) return watchers.some((w) => w.id === m![1]) ? okData({ deleted: true }) : notFound("Watcher");
    // apps and browser profiles
    if (p === "/apps") return okData([{ id: "a1", name: "Shop", services: [{ id: "web", name: "web", kind: "frontend", port: 3001 }], deployments: [], domains: [], runtime: [{ kind: "service", resourceId: "web", status: "running" }] }]);
    if (p === "/apps/a1") return okData({ id: "a1", name: "Shop", services: [{ id: "web", name: "web", kind: "frontend", port: 3001 }], deployments: [], domains: [], runtime: [] });
    if (p.startsWith("/apps/a1/lifecycle/")) return okData({ statuses: [], errors: [] });
    if (p === "/browser-profiles") return okData({ profiles: [{ name: "coach", agents: ["coach"], exists: true, sizeBytes: 2048, hasCookies: true, loginOpen: false }] });
    if (p === "/browser-profiles/coach") return okData({ cleared: true });
    return reply(404, { ok: false, error: `No route ${method} ${p}` });
  });
  return { api, calls, rooms, roomMessages, memory, skills, schedules, checks, connectors, teams, agents, vault };
}

type Fake = ReturnType<typeof fakeInstance>;

async function rpc(deps: McpDeps, method: string, params: Record<string, unknown> = {}) {
  return handleMcpRequest(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), deps);
}
/** A tool call, its result checked as the official MCP client checks it (structuredContent against the outputSchema). */
const call = async (deps: McpDeps, name: string, args: Record<string, unknown> = {}) => {
  const result = (await (await rpc(deps, "tools/call", { name, arguments: args })).json()).result;
  await expectValidOutput(deps, async () => (await (await rpc(deps, "tools/list")).json()).result.tools, name, result);
  return result;
};
const deps = (f: Fake, extra: Partial<McpDeps> = {}): McpDeps => ({ api: f.api, version: "x", pollIntervalMs: 5, publicUrl: "https://polpo.example.com", toolsets: ["all"], ...extra });
const names = async (d: McpDeps) => ((await (await rpc(d, "tools/list")).json()).result.tools as Array<{ name: string; annotations: Record<string, unknown>; outputSchema?: unknown }>);

describe("toolsets and scopes", () => {
  it("offers the new primitives by default, the less common ones only when enabled, all with output schemas", async () => {
    const f = fakeInstance();
    const def = (await names(deps(f, { toolsets: undefined }))).map((t) => t.name);
    for (const n of ["polpo_rooms_list", "polpo_room_post", "polpo_room_wait", "polpo_chat_sessions_list", "polpo_memory_get", "polpo_skills_list", "polpo_skill_assign",
      "polpo_schedules_list", "polpo_schedule_run", "polpo_checks_list", "polpo_connectors_list", "polpo_connector_add", "polpo_channels_list", "polpo_message_send",
      "polpo_teams_list", "polpo_team_save", "polpo_agent_delete"]) expect(def).toContain(n);
    for (const n of ["polpo_brain_search", "polpo_learning_get", "polpo_watchers_list", "polpo_vault_list", "polpo_apps_list", "polpo_api_get"]) expect(def).not.toContain(n);
    // the visible default set, every Configuration section included (the settings toolset) and the task and mission cards, for a full-access client
    expect(def.length).toBeLessThanOrEqual(155);
    const all = await names(deps(f));
    for (const t of all) if (t.name !== "polpo_file_read") expect(t.outputSchema, t.name).toBeTruthy();
    const a = Object.fromEntries(all.map((t) => [t.name, t.annotations]));
    for (const n of ["polpo_agent_delete", "polpo_team_delete", "polpo_room_delete", "polpo_chat_session_delete", "polpo_memory_update", "polpo_skill_delete",
      "polpo_schedule_delete", "polpo_check_cancel", "polpo_check_delete", "polpo_connector_disconnect", "polpo_connector_remove", "polpo_message_send", "polpo_notification_rule_delete",
      "polpo_vault_delete", "polpo_brain_delete", "polpo_learning_revert", "polpo_watcher_delete", "polpo_browser_profile_clear"]) {
      expect(a[n], n).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    }
    for (const n of ["polpo_rooms_list", "polpo_room_messages", "polpo_room_wait", "polpo_chat_messages", "polpo_memory_get", "polpo_skills_list", "polpo_schedules_list",
      "polpo_checks_list", "polpo_connectors_list", "polpo_connector_catalog", "polpo_channels_list", "polpo_vault_list", "polpo_brain_search"]) {
      expect(a[n], n).toMatchObject({ readOnlyHint: true });
    }
    for (const n of ["polpo_room_post", "polpo_message_send", "polpo_connector_add", "polpo_schedule_run"]) expect(a[n], n).toMatchObject({ openWorldHint: true });
  });

  it("a work-scoped client can post, but not send messages, change skills, connectors, channels or the team, nor see the vault", async () => {
    const f = fakeInstance();
    const list = (await names(deps(f, { principal: { kind: "oauth", actor: "ada@example.com via Claude", scopes: ["polpo:read", "polpo:work"] } }))).map((t) => t.name);
    for (const n of ["polpo_room_post", "polpo_memory_update", "polpo_check_create", "polpo_schedule_run", "polpo_skills_list", "polpo_connectors_list"]) expect(list).toContain(n);
    for (const n of ["polpo_message_send", "polpo_channel_test", "polpo_skill_create", "polpo_connector_add", "polpo_notification_rule_save", "polpo_team_save", "polpo_agent_delete", "polpo_vault_list", "polpo_vault_delete", "polpo_learning_revert"]) expect(list).not.toContain(n);
    // sending is its own scope, on top of work or alone
    const messages = (await names(deps(f, { principal: { kind: "oauth", actor: "x", scopes: ["polpo:read", "polpo:messages"] } }))).map((t) => t.name);
    expect(messages).toEqual(expect.arrayContaining(["polpo_message_send", "polpo_channel_test", "polpo_channels_list"]));
    expect(messages).not.toContain("polpo_room_post");
    expect(messages).not.toContain("polpo_notification_rule_save");
    const readOnly = (await names(deps(f, { principal: { kind: "oauth", actor: "x", scopes: ["polpo:read"] } }))).map((t) => t.name);
    expect(readOnly).toContain("polpo_room_messages");
    expect(readOnly).not.toContain("polpo_room_post");
    expect(readOnly).not.toContain("polpo_message_send");
  });
});

describe("team", () => {
  it("lists teams without agents' configuration, creates, renames and moves agents in", async () => {
    const f = fakeInstance();
    const l = await call(deps(f), "polpo_teams_list");
    expect(l.structuredContent.items).toEqual([{ name: "main", agents: ["coach", "writer"] }, { name: "empty", agents: [] }]);
    expect(JSON.stringify(l)).not.toContain("secret prompt");
    const made = await call(deps(f), "polpo_team_save", { name: "growth", description: "Growth team", add_agents: ["writer"] });
    expect(made.structuredContent).toMatchObject({ created: true, team: { name: "growth", agents: ["writer"] } });
    const renamed = await call(deps(f), "polpo_team_save", { name: "growth", new_name: "marketing" });
    expect(renamed.structuredContent).toMatchObject({ created: false, changed: ["name"], team: { name: "marketing" } });
    expect(await call(deps(f), "polpo_team_save", { name: "main", add_agents: ["ghost"] })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/No agent "ghost"/) }] });
  });

  it("deletes only an empty team, and only with confirm", async () => {
    const f = fakeInstance();
    expect(await call(deps(f), "polpo_team_delete", { name: "main", confirm: true })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/still has agents/) }] });
    expect(await call(deps(f), "polpo_team_delete", { name: "empty" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/confirm: true/) }] });
    expect(f.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect((await call(deps(f), "polpo_team_delete", { name: "empty", confirm: true })).structuredContent).toEqual({ name: "empty", removed: true });
  });

  it("removes an agent only with confirm", async () => {
    const f = fakeInstance();
    expect(await call(deps(f), "polpo_agent_delete", { name: "writer" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/confirm: true/) }] });
    expect(f.agents).toHaveLength(2);
    expect((await call(deps(f), "polpo_agent_delete", { name: "writer", confirm: true })).structuredContent).toEqual({ name: "writer", removed: true });
    expect(await call(deps(f), "polpo_agent_delete", { name: "ghost", confirm: true })).toMatchObject({ isError: true });
  });

  it("sets an avatar from base64, checking the bytes, and removes it", async () => {
    const f = fakeInstance();
    const r = await call(deps(f), "polpo_agent_avatar_set", { name: "coach", image: { base64: PNG.toString("base64"), mime_type: "image/png" } });
    expect(r.structuredContent).toEqual({ name: "coach", avatar: ".polpo/avatars/coach.png" });
    const sent = f.calls.find((c) => c.path === "/api/v1/agents/coach/avatar" && c.method === "POST")!.body as FormData;
    expect((sent.get("file") as File).type).toBe("image/png");
    expect(await call(deps(f), "polpo_agent_avatar_set", { name: "coach", image: { base64: Buffer.from("not an image").toString("base64"), mime_type: "image/png" } })).toMatchObject({ isError: true });
    expect((await call(deps(f), "polpo_agent_avatar_set", { name: "coach", remove: true })).structuredContent).toEqual({ name: "coach", avatar: null });
  });

  it("sets an agent's browser egress only to a configured proxy", async () => {
    const f = fakeInstance();
    expect(await call(deps(f), "polpo_agent_update", { name: "coach", browserEgress: "home" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/no egress proxy "home"/) }] });
    await call(deps(f), "polpo_config_update", { egress_proxies: { home: "socks5://user:pw@100.101.55.7:1080" } });
    const r = await call(deps(f), "polpo_agent_update", { name: "coach", browserEgress: "home" });
    expect(r.structuredContent.changed).toEqual(["browserEgress"]);
  });
});

describe("config: egress proxies", () => {
  it("sets and removes the proxies, without showing their credentials", async () => {
    const f = fakeInstance();
    const r = await call(deps(f), "polpo_config_update", { egress_proxies: { home: "socks5://user:pw@100.101.55.7:1080" } });
    expect(f.calls.find((c) => c.method === "PATCH")!.body).toEqual({ egressProxies: { home: "socks5://user:pw@100.101.55.7:1080" } });
    expect(r.structuredContent.changed).toEqual(["egressProxies"]);
    expect(JSON.stringify(r)).not.toContain("user:pw");
    expect(r.structuredContent.settings.egressProxies).toEqual({ home: "socks5://•••@100.101.55.7:1080" });
    expect(await call(deps(f), "polpo_config_update", { egress_proxies: { home: "ftp://x" } })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Input validation error/) }] });
    await call(deps(f), "polpo_config_update", { egress_proxies: null });
    expect(f.calls.filter((c) => c.method === "PATCH").at(-1)!.body).toEqual({ egressProxies: null });
  });
});

describe("rooms", () => {
  it("lists rooms, reads one with its goal, and pages its transcript backwards", async () => {
    const f = fakeInstance();
    const l = await call(deps(f), "polpo_rooms_list", { kind: "web" });
    expect(l.structuredContent.items).toEqual([expect.objectContaining({ id: "web:1", title: "Launch", goal: "Ship it" })]);
    const one = await call(deps(f), "polpo_rooms_list", { id: "web:1" });
    expect(one.structuredContent).toMatchObject({ items: [{ id: "web:1", agents: ["coach", "writer"] }], typing: [] });
    const first = await call(deps(f), "polpo_room_messages", { id: "web:1", limit: 20 });
    expect(first.structuredContent.items.map((m: { id: string }) => m.id)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i + 16}`));
    expect(first.structuredContent.latest_id).toBe("m35");
    const second = await call(deps(f), "polpo_room_messages", { id: "web:1", limit: 20, cursor: first.structuredContent.next_cursor });
    expect(second.structuredContent).toMatchObject({ next_cursor: null });
    expect(second.structuredContent.items).toHaveLength(15);
    expect(await call(deps(f), "polpo_room_messages", { id: "web:1", cursor: "garbage" })).toMatchObject({ isError: true });
    expect(await call(deps(f), "polpo_rooms_list", { id: "web:nope" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/polpo_rooms_list/) }] });
  });

  it("creates and updates a room, saying what changed", async () => {
    const f = fakeInstance();
    const made = await call(deps(f), "polpo_room_create", { title: "Ops", agents: ["coach"], goal: "Keep it up", owner: "coach", reply_mode: "intent" });
    expect(f.calls.find((c) => c.method === "POST" && c.path === "/api/v1/rooms")!.body).toEqual({ title: "Ops", agents: ["coach"], settings: { goal: "Keep it up", owner: "coach", replyMode: "intent" } });
    expect(made.structuredContent.room).toMatchObject({ title: "Ops", goal: "Keep it up", owner: "coach" });
    expect(await call(deps(f), "polpo_room_create", { title: "X", agents: ["ghost"] })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/polpo_agents_list/) }] });
    const upd = await call(deps(f), "polpo_room_update", { id: "web:1", agents: ["coach"], goal: "Ship it" });
    expect(upd.structuredContent.changed).toEqual(["agents"]);
    expect(await call(deps(f), "polpo_room_update", { id: "web:1" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Nothing to change/) }] });
  });

  it("posts as the connected person and waits for the agents' replies", async () => {
    const f = fakeInstance();
    const d = deps(f, { principal: { kind: "oauth", actor: "ada@example.com via Claude", scopes: ["polpo"] } });
    const posted = await call(d, "polpo_room_post", { id: "web:1", text: "@coach can you plan the launch?", reply_to_id: "m35" });
    expect(f.calls.find((c) => c.method === "POST" && c.path === "/api/v1/rooms/web%3A1/messages")!.body).toEqual({ text: "@coach can you plan the launch?", name: "ada@example.com via Claude", replyToId: "m35" });
    expect(posted.structuredContent.message).toMatchObject({ id: "m36", author: "ada@example.com via Claude", addressed_to: ["coach"], reply_to_id: "m35" });
    const waited = await call(d, "polpo_room_wait", { id: "web:1", after_id: "m36", timeout_seconds: 5 });
    expect(waited.structuredContent).toMatchObject({ timed_out: false, latest_id: "m37", typing: [] });
    expect(waited.structuredContent.messages).toEqual([expect.objectContaining({ id: "m37", author: "coach", author_kind: "agent", text: "On it", reply_to_id: "m36" })]);
    // nothing new: it times out and says how to go on
    const idle = await call(d, "polpo_room_wait", { id: "web:1", after_id: "m37", timeout_seconds: 1 });
    expect(idle.structuredContent).toMatchObject({ timed_out: true, messages: [] });
    expect(await call(d, "polpo_room_wait", { id: "web:1", after_id: "nope", timeout_seconds: 1 })).toMatchObject({ isError: true });
  });

  it("deletes a web room only with confirm, never a Telegram one", async () => {
    const f = fakeInstance();
    expect(await call(deps(f), "polpo_room_delete", { id: "web:1" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/confirm: true/) }] });
    expect(await call(deps(f), "polpo_room_delete", { id: "telegram:group:-1", confirm: true })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Telegram/) }] });
    expect((await call(deps(f), "polpo_room_delete", { id: "web:1", confirm: true })).structuredContent).toEqual({ id: "web:1", deleted: true });
    expect(f.rooms.has("web:1")).toBe(false);
  });
});

describe("chat sessions", () => {
  it("lists, filters by agent and reads messages paged, without tool arguments", async () => {
    const f = fakeInstance();
    expect((await call(deps(f), "polpo_chat_sessions_list", { agent: "coach" })).structuredContent.items).toEqual([expect.objectContaining({ id: "s1", agent: "coach", message_count: 3 })]);
    expect((await call(deps(f), "polpo_chat_sessions_list", { agent: "polpo" })).structuredContent.items.map((s: { id: string }) => s.id)).toEqual(["s2"]);
    const page1 = await call(deps(f), "polpo_chat_messages", { id: "s2", limit: 10 });
    expect(page1.structuredContent.items.map((m: { id: string }) => m.id)).toEqual(Array.from({ length: 10 }, (_, i) => `cm${i + 16}`));
    const page3 = await call(deps(f), "polpo_chat_messages", { id: "s2", limit: 10, cursor: (await call(deps(f), "polpo_chat_messages", { id: "s2", limit: 10, cursor: page1.structuredContent.next_cursor })).structuredContent.next_cursor });
    expect(page3.structuredContent.items).toHaveLength(5);
    expect(page3.structuredContent.items[3]).toMatchObject({ id: "cm4", tools: ["set_vault_entry"] });
    expect(JSON.stringify(page3)).not.toContain("credentials");
    expect(await call(deps(f), "polpo_chat_messages", { id: "nope" })).toMatchObject({ isError: true });
  });

  it("renames, stars, and deletes only with confirm", async () => {
    const f = fakeInstance();
    const r = await call(deps(f), "polpo_chat_session_update", { id: "s1", title: "Plan", starred: true });
    expect(r.structuredContent.session).toMatchObject({ id: "s1", title: "Plan", starred: true });
    expect(await call(deps(f), "polpo_chat_session_update", { id: "s1" })).toMatchObject({ isError: true });
    expect(await call(deps(f), "polpo_chat_session_delete", { id: "s1" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/confirm: true/) }] });
    expect((await call(deps(f), "polpo_chat_session_delete", { id: "s1", confirm: true })).structuredContent).toEqual({ id: "s1", deleted: true });
  });
});

describe("memory", () => {
  it("reads shared and agent memory, appends, and needs confirm to replace or clear", async () => {
    const f = fakeInstance();
    expect((await call(deps(f), "polpo_memory_get")).structuredContent).toMatchObject({ scope: "shared", content: "We ship on Fridays." });
    const app = await call(deps(f), "polpo_memory_update", { mode: "append", content: "Releases need a changelog." });
    expect(f.memory.shared).toBe("We ship on Fridays.\n\nReleases need a changelog.\n");
    expect(app.structuredContent).toMatchObject({ previous_chars: 19 });
    expect(await call(deps(f), "polpo_memory_update", { mode: "replace", content: "New" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/confirm: true/) }] });
    expect(await call(deps(f), "polpo_memory_update", { mode: "clear" })).toMatchObject({ isError: true });
    expect(f.memory.shared).toContain("Fridays");
    await call(deps(f), "polpo_memory_update", { mode: "clear", confirm: true });
    expect(f.memory.shared).toBe("");
    // an empty agent memory can be written without confirm
    await call(deps(f), "polpo_memory_update", { agent: "coach", mode: "replace", content: "Prefers mornings" });
    expect(f.memory.coach).toBe("Prefers mornings");
    expect(await call(deps(f), "polpo_memory_update", { mode: "append" })).toMatchObject({ isError: true, content: [{ text: "append needs content." }] });
  });
});

describe("skills", () => {
  it("lists with filters and reads one without its server path", async () => {
    const f = fakeInstance();
    expect((await call(deps(f), "polpo_skills_list", { agent: "writer" })).structuredContent.items).toEqual([expect.objectContaining({ name: "weekly-report", assigned_to: ["writer"] })]);
    const s = await call(deps(f), "polpo_skill_get", { name: "weekly-report" });
    expect(s.structuredContent.skill).toMatchObject({ name: "weekly-report", content: "# Steps\n1. Do it" });
    expect(JSON.stringify(s)).not.toContain("/abs/secret/path");
  });

  it("creates and assigns, refuses duplicates, updates content and tags, installs, assigns idempotently", async () => {
    const f = fakeInstance();
    const c = await call(deps(f), "polpo_skill_create", { name: "triage", description: "Triage bugs", content: "# Triage", assign_to: ["coach"] });
    expect(c.structuredContent.skill).toMatchObject({ name: "triage", assigned_to: ["coach"] });
    expect(await call(deps(f), "polpo_skill_create", { name: "triage", description: "x", content: "y" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/polpo_skill_update/) }] });
    expect(await call(deps(f), "polpo_skill_create", { name: "bad name!", description: "x", content: "y" })).toMatchObject({ isError: true });
    const u = await call(deps(f), "polpo_skill_update", { name: "global-one", content: "New body", tags: ["x"] });
    expect(u.structuredContent.changed).toEqual(["content", "tags"]);
    expect(f.calls.find((x) => x.method === "PUT" && x.path === "/api/v1/skills/global-one")!.body).toEqual({ content: "New body", global: true });
    const i = await call(deps(f), "polpo_skill_install", { source: "anthropics/skills" });
    expect(i.structuredContent).toEqual({ installed: ["pdf"], skipped: ["weekly-report"], errors: [] });
    expect(await call(deps(f), "polpo_skill_install", { source: "bad/repo" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/repository not found/) }] });
    const a = await call(deps(f), "polpo_skill_assign", { name: "weekly-report", agents: ["writer", "coach"] });
    expect(a.structuredContent).toMatchObject({ agents: ["coach"], assigned_to: ["writer", "coach"] });
    const un = await call(deps(f), "polpo_skill_assign", { name: "weekly-report", agents: ["writer"], action: "unassign" });
    expect(un.structuredContent.assigned_to).toEqual(["coach"]);
    expect(await call(deps(f), "polpo_skill_assign", { name: "weekly-report", agents: ["ghost"] })).toMatchObject({ isError: true });
  });

  it("deletes a skill only with confirm (a global one in the global pool)", async () => {
    const f = fakeInstance();
    expect(await call(deps(f), "polpo_skill_delete", { name: "weekly-report" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/used by writer/) }] });
    await call(deps(f), "polpo_skill_delete", { name: "global-one", confirm: true });
    expect(f.calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/skills/global-one?global=true")).toBe(true);
  });
});

describe("automation", () => {
  it("lists schedules, one with its runs; creates, pauses, resumes, runs now and deletes with confirm", async () => {
    const f = fakeInstance();
    const l = await call(deps(f), "polpo_schedules_list");
    expect(l.structuredContent.items).toEqual([expect.objectContaining({ mission_id: "m1", mission: "Daily digest", recurring: true, enabled: true, paused: false, missed_runs: 0, catch_up: "once" })]);
    // the status of a run and the runs missed while the server was down are shown
    Object.assign(f.schedules[0]!, { lastRunAt: "2026-11-21T09:00:00.000Z", lastOutcome: "failed", lastError: "boom", missedRuns: 2, lastMissedAt: "2026-11-20T09:00:00.000Z", catchUp: "none" });
    const status = await call(deps(f), "polpo_schedules_list");
    expect(status.structuredContent.items[0]).toMatchObject({ last_outcome: "failed", last_error: "boom", missed_runs: 2, last_missed_at: "2026-11-20T09:00:00.000Z", catch_up: "none" });
    expect(status.content[0].text).toMatch(/last 2026-11-21 09:00 \(failed\) · boom · 2 missed while down/);
    for (const k of ["lastRunAt", "lastOutcome", "lastError", "missedRuns", "lastMissedAt", "catchUp"]) delete (f.schedules[0] as Record<string, unknown>)[k];
    const one = await call(deps(f), "polpo_schedules_list", { mission_id: "m1" });
    expect(one.structuredContent.runs.map((t: { id: string }) => t.id)).toEqual(["t1"]);
    expect(await call(deps(f), "polpo_schedules_list", { mission_id: "m9" })).toMatchObject({ isError: true });
    expect((await call(deps(f), "polpo_schedule_create", { mission_id: "m2", expression: "0 8 * * *", recurring: true })).structuredContent.schedule).toMatchObject({ mission_id: "m2", recurring: true });
    expect(await call(deps(f), "polpo_schedule_create", { mission_id: "m2", expression: "nope" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/5-field cron/) }] });
    expect(await call(deps(f), "polpo_schedule_create", { mission_id: "m7", expression: "0 8 * * *" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/polpo_missions_list/) }] });
    const pausedUpdate = await call(deps(f), "polpo_schedule_update", { mission_id: "m1", enabled: false });
    expect(pausedUpdate.structuredContent).toMatchObject({ changed: ["enabled"], schedule: { enabled: false, paused: true } });
    expect((await call(deps(f), "polpo_schedules_list", { enabled: false })).content[0].text).toMatch(/PAUSED/);
    expect((await call(deps(f), "polpo_schedule_update", { mission_id: "m1", catch_up: "none" })).structuredContent).toMatchObject({ changed: ["catchUp"], schedule: { catch_up: "none" } });
    expect((await call(deps(f), "polpo_schedule_update", { mission_id: "m1", enabled: true })).structuredContent.schedule.enabled).toBe(true);
    const run = await call(deps(f), "polpo_schedule_run", { mission_id: "m1" });
    expect(run.structuredContent.schedule.last_run_at).toEqual(expect.any(String));
    expect(await call(deps(f), "polpo_schedule_delete", { mission_id: "m1" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/confirm: true/) }] });
    expect((await call(deps(f), "polpo_schedule_delete", { mission_id: "m1", confirm: true })).structuredContent).toEqual({ mission_id: "m1", deleted: true });
  }, 20_000);

  it("creates recurring checks attributed to the caller, changes, confirms and cancels them", async () => {
    const f = fakeInstance();
    const d = deps(f, { principal: { kind: "oauth", actor: "ada@example.com via Claude", scopes: ["polpo"] } });
    expect(await call(d, "polpo_check_create", { instructions: "Look at PRs" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/when it runs/) }] });
    expect(await call(d, "polpo_check_create", { every_minutes: 30 })).toMatchObject({ isError: true });
    expect(await call(d, "polpo_check_create", { agent: "ghost", instructions: "x", every_minutes: 30 })).toMatchObject({ isError: true });
    const c = await call(d, "polpo_check_create", { agent: "coach", instructions: "Look at the open PRs", cron: "0 9 * * 1-5", timezone: "Europe/Rome", to: "Team" });
    expect(f.calls.find((x) => x.method === "POST" && x.path === "/api/v1/checks")!.body).toMatchObject({ agent: "coach", prompt: "Look at the open PRs", cron: "0 9 * * 1-5", timezone: "Europe/Rome", to: "Team", createdBy: "ada@example.com via Claude" });
    expect(c.structuredContent.check).toMatchObject({ id: "chk1", state: "active", agent: "coach", schedule: "cron 0 9 * * 1-5" });
    f.checks[0]!.state = "proposed";
    const conf = await call(d, "polpo_check_update", { id: "chk1", every_minutes: 60, confirm: true });
    expect(f.calls.find((x) => x.method === "PATCH")!.body).toEqual({ everyMinutes: 60, cron: null, confirm: true });
    expect(conf.structuredContent.check.state).toBe("active");
    expect((await call(d, "polpo_checks_list", { state: "active" })).structuredContent.items).toHaveLength(1);
    expect(await call(d, "polpo_check_cancel", { id: "chk1" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/confirm: true/) }] });
    expect((await call(d, "polpo_check_cancel", { id: "chk1", confirm: true })).structuredContent.check.state).toBe("cancelled");
    expect(await call(d, "polpo_check_cancel", { id: "nope", confirm: true })).toMatchObject({ isError: true });
    // a cancelled check can now be deleted for good (live: it stayed listed for ever)
    expect(await call(d, "polpo_check_delete", { id: "chk1" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/\(cancelled\).*confirm: true/) }] });
    expect((await call(d, "polpo_check_delete", { id: "chk1", confirm: true })).structuredContent).toEqual({ deleted: "chk1" });
    expect(f.checks).toEqual([]);
    expect(f.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/api/v1/checks/chk1?purge=true" });
    expect(await call(d, "polpo_check_delete", { id: "chk1", confirm: true })).toMatchObject({ isError: true });
  });

  it("watchers: creates (no shell actions), lists and deletes with confirm", async () => {
    const f = fakeInstance();
    const w = await call(deps(f), "polpo_watcher_create", { task_id: "t1", target_status: "failed", action: { type: "create_task", title: "Fix it", description: "Look", assignTo: "coach" } });
    expect(w.structuredContent.watcher).toMatchObject({ id: "w1", task_id: "t1", target_status: "failed" });
    expect(await call(deps(f), "polpo_watcher_create", { task_id: "t1", target_status: "failed", action: { type: "run_script", command: "rm -rf /" } })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Input validation error/) }] });
    expect((await call(deps(f), "polpo_watchers_list")).structuredContent.items).toHaveLength(1);
    expect(await call(deps(f), "polpo_watcher_delete", { id: "w1" })).toMatchObject({ isError: true });
    expect((await call(deps(f), "polpo_watcher_delete", { id: "w1", confirm: true })).structuredContent).toEqual({ id: "w1", deleted: true });
  });
});

describe("connectors", () => {
  it("lists without secrets, one with its tools, and searches the catalog", async () => {
    const f = fakeInstance();
    const l = await call(deps(f), "polpo_connectors_list");
    expect(l.structuredContent.items).toEqual([expect.objectContaining({ id: "linear", status: "connected", authorized: true, agents: ["coach"], tool_count: 12 })]);
    expect(l.structuredContent.items[0].secrets).toBeUndefined();
    expect(l.structuredContent.items[0].url).toBe("https://mcp.linear.app/mcp?…");
    expect(JSON.stringify(l)).not.toContain(SECRET);
    const one = await call(deps(f), "polpo_connectors_list", { id: "linear" });
    expect(one.structuredContent.tools).toEqual([{ name: "create_issue", description: "Create an issue", policy: "allow" }, { name: "delete_issue", policy: "off" }]);
    const cat = await call(deps(f), "polpo_connector_catalog", { text: "payments" });
    expect(cat.structuredContent.items).toEqual([expect.objectContaining({ id: "stripe", auth: "bearer", needs: "a token, entered in the dashboard" })]);
  });

  it("adds from the catalog with an OAuth link, sends token-based ones to the dashboard, and never asks for a secret", async () => {
    const f = fakeInstance();
    const added = await call(deps(f), "polpo_connector_add", { catalog_id: "notion", agents: ["coach"] });
    expect(added.structuredContent).toMatchObject({ authorization_url: "https://auth.example.com/authorize?state=abc&c=notion", connector: { id: "notion", agents: ["coach"] } });
    expect(f.calls.find((c) => c.method === "POST" && c.path === "/api/v1/connectors")!.body).toEqual({ catalogId: "notion", access: { agents: ["coach"] } });
    const stripe = await call(deps(f), "polpo_connector_add", { catalog_id: "stripe" });
    // the link opens the connector's form, focused on the token, and says what to wait for
    expect(stripe.structuredContent).toMatchObject({
      setup_url: expect.stringMatching(/^https:\/\/polpo\.example\.com\/connectors\?connector=stripe&focus=bearerToken&setup=connector%3Astripe%3AbearerToken$/),
      setup_id: "connector:stripe:bearerToken", next_step: expect.stringContaining("polpo_setup_wait"),
    });
    expect(stripe.structuredContent.authorization_url).toBeUndefined();
    expect(await call(deps(f), "polpo_connector_add", { catalog_id: "azure" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/\{organization\}/) }] });
    expect(await call(deps(f), "polpo_connector_add", {})).toMatchObject({ isError: true });
    // a token argument does not exist: the schema has no place for it
    const tools = await names(deps(f));
    const add = tools.find((t) => t.name === "polpo_connector_add") as unknown as { inputSchema: { properties: Record<string, unknown> } };
    expect(Object.keys(add.inputSchema.properties)).not.toEqual(expect.arrayContaining(["token"]));
    // a custom remote URL is always a remote transport (never a local process)
    const custom = await call(deps(f), "polpo_connector_add", { url: "https://mcp.acme.dev/mcp" });
    expect(f.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/connectors").at(-1)!.body).toMatchObject({ url: "https://mcp.acme.dev/mcp", name: "acme.dev", transport: { type: "http" } });
    expect(custom.structuredContent.connector).toMatchObject({ status: expect.any(String) });
  });

  it("updates access and tool policy, tests, links OAuth, disconnects and removes with confirm", async () => {
    const f = fakeInstance();
    const u = await call(deps(f), "polpo_connector_update", { id: "linear", add_agents: ["writer"], tool_policy: { delete_issue: "ask" } });
    expect(f.calls.find((c) => c.method === "PATCH")!.body).toEqual({ access: { agents: ["coach", "writer"], polpo: true }, toolPolicy: { delete_issue: "ask" } });
    expect(u.structuredContent.changed).toEqual(["agents", "tool_policy"]);
    expect(await call(deps(f), "polpo_connector_update", { id: "linear", agents: ["ghost"] })).toMatchObject({ isError: true });
    const t = await call(deps(f), "polpo_connector_test", { id: "linear" });
    expect(t.structuredContent).toMatchObject({ ok: false, status: "needs_auth" });
    expect(t.content[0].text).toMatch(/polpo_connector_connect/);
    expect((await call(deps(f), "polpo_connector_connect", { id: "linear" })).structuredContent.authorization_url).toMatch(/^https:\/\/auth\.example\.com/);
    expect(await call(deps(f), "polpo_connector_disconnect", { id: "linear" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/confirm: true/) }] });
    expect((await call(deps(f), "polpo_connector_disconnect", { id: "linear", confirm: true })).structuredContent.connector.status).toBe("needs_auth");
    expect(await call(deps(f), "polpo_connector_remove", { id: "linear" })).toMatchObject({ isError: true });
    expect((await call(deps(f), "polpo_connector_remove", { id: "linear", confirm: true })).structuredContent).toEqual({ id: "linear", removed: true });
    expect(f.connectors.has("linear")).toBe(false);
  });
});

describe("channels", () => {
  it("lists channels, rules, Telegram chats and WhatsApp without any token", async () => {
    const f = fakeInstance();
    const r = await call(deps(f), "polpo_channels_list");
    expect(r.structuredContent).toMatchObject({
      channels: [{ name: "ops", type: "telegram" }], rules: [{ id: "r1", events: ["task:failed"], channels: ["ops"] }],
      telegram: { bots: [{ key: "ops" }], chats: [{ id: "telegram:group:-100", kind: "group", name: "Team" }] },
      whatsapp: [{ profile: "default", status: "authenticated" }], setup_url: "https://polpo.example.com/config?section=channels",
    });
    expect(JSON.stringify(r)).not.toContain("••••oken");
    expect(JSON.stringify(r)).not.toContain("botToken");
    expect(JSON.stringify(r)).not.toContain("/abs");
  });

  it("sends only with confirm, on Telegram, WhatsApp and email", async () => {
    const f = fakeInstance();
    const preview = await call(deps(f), "polpo_message_send", { channel: "telegram", to: "Team", text: "Deploy done" });
    expect(preview).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/not sent[\s\S]*confirm: true/) }] });
    expect(f.calls.some((c) => c.path.includes("/send"))).toBe(false);
    expect((await call(deps(f), "polpo_message_send", { channel: "telegram", to: "Team", text: "Deploy done", files: ["out/report.pdf"], confirm: true })).structuredContent).toMatchObject({ sent: true, channel: "telegram" });
    expect(f.calls.find((c) => c.path === "/api/v1/telegram/send")!.body).toEqual({ to: "Team", text: "Deploy done", files: ["out/report.pdf"] });
    expect((await call(deps(f), "polpo_message_send", { channel: "whatsapp", to: "+39333", text: "Hi", confirm: true })).structuredContent).toMatchObject({ sent: true, message_id: "wa1" });
    expect(await call(deps(f), "polpo_message_send", { channel: "email", to: "a@b.c", text: "Body", confirm: true })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/subject/) }] });
    const mail = await call(deps(f), "polpo_message_send", { channel: "email", to: ["a@b.c", "d@e.f"], subject: "Report", text: "Body", agent: "writer", confirm: true });
    expect(mail.structuredContent).toMatchObject({ sent: true, message_id: "<mail1@x>" });
    expect(f.calls.find((c) => c.path === "/api/v1/email/send")!.body).toEqual({ to: ["a@b.c", "d@e.f"], subject: "Report", body: "Body", agent: "writer" });
    expect(await call(deps(f), "polpo_message_send", { channel: "whatsapp", to: ["a", "b"], text: "x", confirm: true })).toMatchObject({ isError: true });
  });

  it("tests a channel and saves or deletes rules", async () => {
    const f = fakeInstance();
    expect((await call(deps(f), "polpo_channel_test", { name: "ops" })).structuredContent).toEqual({ name: "ops", success: true });
    expect(await call(deps(f), "polpo_notification_rule_save", { id: "r2", events: ["mission:completed"], channels: ["slack"] })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/No channel "slack"/) }] });
    const s = await call(deps(f), "polpo_notification_rule_save", { id: "r2", name: "Done", events: ["mission:completed"], channels: ["ops"], cooldown_minutes: 5 });
    expect(s.structuredContent).toMatchObject({ created: true, rule: { id: "r2" } });
    expect(f.calls.find((c) => c.method === "PUT")!.body).toMatchObject({ cooldownMs: 300000 });
    expect(await call(deps(f), "polpo_notification_rule_delete", { id: "r2" })).toMatchObject({ isError: true });
    expect((await call(deps(f), "polpo_notification_rule_delete", { id: "r2", confirm: true })).structuredContent).toEqual({ id: "r2", deleted: true });
  });
});

describe("vault", () => {
  it("lists names and fields only, never values, with a dashboard link", async () => {
    const f = fakeInstance();
    const r = await call(deps(f), "polpo_vault_list");
    expect(r.structuredContent.items).toEqual([
      { agent: "coach", service: "gmail", type: "smtp", label: "Mail", fields: ["host", "user", "password"] },
      { agent: "coach", service: "shared-api", type: "api_key", fields: ["key"], shared_from: "writer" },
    ]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect((await call(deps(f), "polpo_vault_list", { agent: "coach" })).structuredContent.setup_url).toBe("https://polpo.example.com/agents/coach?tab=credentials");
    // no tool takes a secret value
    const tools = (await names(deps(f))).filter((t) => t.name.startsWith("polpo_vault")) as unknown as Array<{ inputSchema: { properties: Record<string, unknown> } }>;
    for (const t of tools) expect(Object.keys(t.inputSchema.properties)).not.toEqual(expect.arrayContaining(["value", "credentials", "password"]));
  });

  it("deletes an entry only with confirm, never a shared one", async () => {
    const f = fakeInstance();
    expect(await call(deps(f), "polpo_vault_delete", { agent: "coach", service: "gmail" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/confirm: true/) }] });
    expect(await call(deps(f), "polpo_vault_delete", { agent: "coach", service: "shared-api", confirm: true })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/shared/) }] });
    expect((await call(deps(f), "polpo_vault_delete", { agent: "coach", service: "gmail", confirm: true })).structuredContent).toEqual({ agent: "coach", service: "gmail", removed: true });
    expect(f.vault.coach!.map((e) => e.service)).toEqual(["shared-api"]);
  });

  it("is not offered without the admin scope", async () => {
    const f = fakeInstance();
    const list = (await names(deps(f, { principal: { kind: "oauth", actor: "x", scopes: ["polpo:read", "polpo:work"] } }))).map((t) => t.name);
    expect(list.filter((n) => n.startsWith("polpo_vault"))).toEqual([]);
  });
});

describe("brain, learning, apps", () => {
  it("searches, reads, saves and deletes (with confirm) in the company brain", async () => {
    const f = fakeInstance();
    expect((await call(deps(f), "polpo_brain_search", { text: "acme" })).structuredContent.items).toEqual([{ id: "e1", type: "company", name: "Acme", summary: "A customer", score: 3 }]);
    expect((await call(deps(f), "polpo_brain_search", { limit: 1 })).structuredContent).toMatchObject({ items: [{ id: "e1" }], next_cursor: expect.any(String), stats: { entities: 2 } });
    const e = await call(deps(f), "polpo_brain_get", { id: "e1" });
    expect(e.structuredContent.relations).toHaveLength(1);
    expect(e.content[0].text).toContain("revenue");
    expect((await call(deps(f), "polpo_brain_save", { entity: { type: "person", name: "Bob" } })).structuredContent).toMatchObject({ kind: "entity", saved: { id: "e3", name: "Bob" } });
    expect(await call(deps(f), "polpo_brain_save", {})).toMatchObject({ isError: true });
    expect(await call(deps(f), "polpo_brain_delete", { kind: "entity", id: "e1" })).toMatchObject({ isError: true });
    expect((await call(deps(f), "polpo_brain_delete", { kind: "entity", id: "e1", confirm: true })).structuredContent).toEqual({ kind: "entity", id: "e1", deleted: true });
  });

  it("shows, reviews and reverts what an agent learned", async () => {
    const f = fakeInstance();
    expect((await call(deps(f), "polpo_learning_get", { agent: "coach" })).structuredContent.changes).toHaveLength(1);
    expect((await call(deps(f), "polpo_learning_review", { agent: "coach" })).structuredContent.changes).toHaveLength(1);
    expect(await call(deps(f), "polpo_learning_revert", { agent: "coach", change_id: "lc0" })).toMatchObject({ isError: true });
    expect((await call(deps(f), "polpo_learning_revert", { agent: "coach", change_id: "lc0", confirm: true })).structuredContent.change).toMatchObject({ reverted: true });
    expect(await call(deps(f), "polpo_learning_get", { agent: "ghost" })).toMatchObject({ isError: true });
  });

  it("lists apps and browser profiles; stop and clear need confirm", async () => {
    const f = fakeInstance();
    expect((await call(deps(f), "polpo_apps_list")).structuredContent.items).toEqual([expect.objectContaining({ id: "a1", running: 1, services: [expect.objectContaining({ name: "web", status: "running", url: "http://127.0.0.1:3001/" })] })]);
    expect((await call(deps(f), "polpo_app_control", { id: "a1", action: "start" })).structuredContent.errors).toEqual([]);
    expect(await call(deps(f), "polpo_app_control", { id: "a1", action: "stop" })).toMatchObject({ isError: true });
    expect(await call(deps(f), "polpo_app_control", { id: "a1", action: "stop", confirm: true })).not.toHaveProperty("isError");
    expect((await call(deps(f), "polpo_browser_profiles_list")).structuredContent.items).toEqual([{ name: "coach", agents: ["coach"], exists: true, signed_in: true, size: "2.0 KB" }]);
    expect(await call(deps(f), "polpo_browser_profile_clear", { name: "coach" })).toMatchObject({ isError: true });
    expect((await call(deps(f), "polpo_browser_profile_clear", { name: "coach", confirm: true })).structuredContent).toEqual({ name: "coach", cleared: true });
  });
});
