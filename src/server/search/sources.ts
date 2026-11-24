/**
 * Where the global search looks: one source per area of the instance.
 *
 * Lists that the dashboard reads through the API (agents, skills, connectors, computers, apps,
 * data, schedules, playbooks, approvals, members, channels, memory) are read the same way, in
 * process: the search sees exactly what the dashboard shows, already redacted (no vault values,
 * no tokens). Tasks, missions, chats, groups and artifacts come straight from their stores (they
 * are large; the stores are fast). Chat messages use the database's full-text index when the
 * store has one (SessionStore.searchMessages), a bounded scan of the latest chats otherwise.
 */
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Message, MessageSearchHit, Session, SessionStore } from "@polpo-ai/core/session-store";
import type { RoomMessage, RoomStore } from "@polpo-ai/core/room-store";
import type { ArtifactStore } from "@polpo-ai/core/artifacts";
import { highlightRanges, maskSecrets, matchScore, snippet, words, type ParsedQuery } from "./text.js";
import { toResult, type SearchDoc, type SearchResult, type SearchSource, type SearchType, type SourceQueryContext } from "./engine.js";

export interface SearchSourceDeps {
  /** GET an API path in process (as the dashboard would), its data; undefined when it fails. */
  api: (path: string) => Promise<unknown>;
  sessions: () => SessionStore | undefined;
  rooms: () => RoomStore | undefined;
  tasks: () => Promise<Array<{ id: string; title: string; description?: string; status: string; assignTo?: string; group?: string; missionId?: string; updatedAt?: string; createdAt?: string }>>;
  missions: () => Promise<Array<{ id: string; name: string; prompt?: string; data?: string; status: string; updatedAt?: string; createdAt?: string }>>;
  artifacts: () => ArtifactStore | undefined;
  /** Folders whose files are searched by name, and the folder links are relative to. */
  files: () => { roots: string[]; base: string };
  /** The latest events of the bus (newest last). */
  recentEvents: () => ReadonlyArray<{ id: string; event: string; data: unknown; ts: number }>;
}

const enc = encodeURIComponent;
const clip = (s: string | undefined, n: number) => (s && s.length > n ? s.slice(0, n) : s ?? "");
const arr = <T = Record<string, any>>(v: unknown, key?: string): T[] => {
  if (Array.isArray(v)) return v as T[];
  if (key && v && typeof v === "object" && Array.isArray((v as Record<string, unknown>)[key])) return (v as Record<string, T[]>)[key]!;
  return [];
};
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Text of an artifact for matching: markup and JSON punctuation removed. */
export function plainText(content: string): string {
  return content
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[{}[\]"]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Results of one item per conversation, from its best matching messages. */
function conversationResults<T>(
  q: ParsedQuery,
  hits: T[],
  pick: (hit: T) => { key: string; text: string; ts: string; messageId: string; author: string; role?: string },
  describe: (key: string) => { title: string; subtitle?: string; url: string; meta?: Record<string, unknown> } | undefined,
  type: SearchType,
): SearchResult[] {
  const best = new Map<string, { hit: ReturnType<typeof pick>; quality: number; count: number }>();
  for (const h of hits) {
    const p = pick(h);
    const quality = matchScore(q, words(p.text));
    if (!quality) continue; // the index said so, the words do not: never shown
    const prev = best.get(p.key);
    if (!prev) { best.set(p.key, { hit: p, quality, count: 1 }); continue; }
    prev.count++;
    if (quality > prev.quality || (quality === prev.quality && p.ts > prev.hit.ts)) { prev.hit = p; prev.quality = quality; }
  }
  const now = Date.now();
  const out: SearchResult[] = [];
  for (const [key, { hit, quality, count }] of best) {
    const d = describe(key);
    if (!d) continue;
    const age = Math.max(0, (now - (Date.parse(hit.ts) || 0)) / 86_400_000);
    const text = maskSecrets(hit.text);
    const titleHighlights = highlightRanges(d.title, q);
    out.push({
      type,
      id: key,
      title: d.title,
      ...(titleHighlights.length ? { titleHighlights } : {}),
      ...(d.subtitle ? { subtitle: d.subtitle } : {}),
      snippet: snippet(text, q),
      url: d.url,
      updatedAt: hit.ts,
      score: Math.round(200 + 100 * quality + 60 * Math.exp(-age / 14) + Math.min(20, 4 * (count - 1))),
      meta: { ...d.meta, messageId: hit.messageId, author: hit.author, ...(hit.role ? { role: hit.role } : {}), matches: count },
    });
  }
  return out;
}

/** Messages to scan when there is no index: the latest of the most recent chats, within a time budget. */
async function scanRecentMessages(store: SessionStore, sessions: Session[], q: ParsedQuery, signal: AbortSignal): Promise<MessageSearchHit[]> {
  const started = Date.now();
  const out: MessageSearchHit[] = [];
  const recent = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 60);
  for (const s of recent) {
    if (signal.aborted || Date.now() - started > 250) break;
    let messages: Message[] = [];
    try { messages = await store.getRecentMessages(s.id, 80); } catch { continue; }
    for (const m of messages) {
      if (!m.content || matchScore(q, words(m.content)) === 0) continue;
      out.push({ sessionId: s.id, messageId: m.id, role: m.role, content: clip(m.content, 4000), ts: m.ts });
    }
  }
  return out;
}

/** Walk folders for file and folder names (bounded: entries, depth, time). */
async function walkFiles(roots: string[], base: string): Promise<SearchDoc[]> {
  const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", ".cache", ".polpo", ".venv", "venv", "target", ".turbo"]);
  const MAX = 20_000;
  const started = Date.now();
  const docs: SearchDoc[] = [];
  const seen = new Set<string>();
  const rel = (abs: string) => {
    const r = relative(base, abs);
    return !r ? "." : r.startsWith("..") ? abs : r.split(sep).join("/");
  };
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8 || docs.length >= MAX || Date.now() - started > 1500 || seen.has(dir)) return;
    seen.add(dir);
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    const folder = rel(dir);
    for (const e of entries) {
      if (docs.length >= MAX) return;
      if (SKIP.has(e.name) || e.name.startsWith(".") && e.name !== ".github") continue;
      const abs = join(dir, e.name);
      const path = rel(abs);
      const isDir = e.isDirectory();
      docs.push({
        type: "file",
        id: path,
        title: e.name,
        subtitle: folder === "." ? "Workspace" : folder,
        keywords: path.replace(/[/._-]+/g, " "),
        url: isDir ? `/files?path=${enc(path)}` : `/files?path=${enc(folder)}&highlight=${enc(e.name)}`,
        meta: { path, kind: isDir ? "directory" : "file", folder },
      });
      if (isDir) await walk(abs, depth + 1);
    }
  }
  for (const r of roots) await walk(r, 0);
  return docs;
}

/** A short line about an event's payload (title, agent, status…), never the whole payload. */
function eventSummary(data: unknown): { text: string; url: string; agent?: string } {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, any>;
  const task = d.task && typeof d.task === "object" ? d.task : undefined;
  const parts = [
    str(task?.title) ?? str(d.title) ?? str(d.name),
    str(d.agentName) ?? str(d.agent) ?? str(task?.assignTo),
    str(d.status) ?? str(d.to) ?? str(task?.status),
    clip(str(d.message) ?? str(d.error) ?? str(d.summary), 200),
  ].filter(Boolean) as string[];
  const taskId = str(task?.id) ?? str(d.taskId);
  const missionId = str(d.missionId);
  return {
    text: maskSecrets(parts.join(" · ")),
    url: taskId ? `/tasks/${enc(taskId)}` : missionId ? `/missions/${enc(missionId)}` : "/events",
    ...(str(d.agentName) ?? str(d.agent) ? { agent: str(d.agentName) ?? str(d.agent) } : {}),
  };
}

/** Events worth finding (not the streaming noise). */
const NOISY_EVENT = /(delta|stream|progress|heartbeat|token|typing|presence|log$|:output|activity)/i;

export function buildSearchSources(deps: SearchSourceDeps): SearchSource[] {
  // the chats' list, shared by the title source and the message query
  let sessionList: { at: number; sessions: Session[] } | undefined;
  const sessionsNow = async (): Promise<Session[]> => {
    const store = deps.sessions();
    if (!store) return [];
    if (sessionList && Date.now() - sessionList.at < 5_000) return sessionList.sessions;
    const sessions = await store.listSessions();
    sessionList = { at: Date.now(), sessions };
    return sessions;
  };
  const chatTitle = (s: Session) => s.title?.trim() || "Untitled chat";
  const chatSubtitle = (s: Session) => (s.agent ? `Chat with ${s.agent}` : "Chat with Polpo");
  const chatMeta = (s: Session) => ({ agent: s.agent ?? null, messages: s.messageCount, ...(s.starred ? { starred: true } : {}), ...(s.scope ? { scope: s.scope } : {}) });

  // groups and their latest messages
  let roomCache: { at: number; rooms: Array<{ id: string; title: string; agents: string[]; updatedAt: string }>; messages: RoomMessage[] } | undefined;
  const roomsNow = async () => {
    const store = deps.rooms();
    if (!store) return { rooms: [], messages: [] as RoomMessage[] };
    if (roomCache && Date.now() - roomCache.at < 15_000) return roomCache;
    const rooms = await store.listRooms();
    const messages = (await Promise.all(rooms.slice(0, 50).map((r) => store.getRecentMessages(r.id, 400).catch(() => [] as RoomMessage[])))).flat();
    roomCache = { at: Date.now(), rooms, messages };
    return roomCache;
  };

  // artifacts' text, refetched only when one changes
  const artifactText = new Map<string, { updatedAt: string; text: string }>();

  const sources: SearchSource[] = [
    {
      type: "chat",
      ttlMs: 5_000,
      docs: async () => (await sessionsNow()).map((s) => ({
        type: "chat" as const, id: s.id, title: chatTitle(s), subtitle: chatSubtitle(s), keywords: s.agent ?? "polpo",
        url: `/chat?session=${enc(s.id)}`, updatedAt: s.updatedAt, meta: chatMeta(s),
      })),
      query: async (q: ParsedQuery, ctx: SourceQueryContext) => {
        const store = deps.sessions();
        if (!store) return [];
        const sessions = await sessionsNow();
        const byId = new Map(sessions.map((s) => [s.id, s]));
        let hits: MessageSearchHit[] = [];
        let indexed = false;
        if (store.searchMessages) {
          try {
            // stems are word prefixes ("missioni" → "mission"): the index finds every form
            hits = await store.searchMessages({ terms: q.terms.map((t) => (t.stem.length >= 3 ? t.stem : t.text)), limit: 300 });
            indexed = true;
          } catch { /* no index (older database): scan instead */ }
        }
        if (ctx.signal.aborted) return [];
        // typos are not in the index: look through the latest chats too when it found little
        if (!indexed || (hits.length < 5 && q.terms.some((t) => t.fuzzy))) {
          const seen = new Set(hits.map((h) => h.messageId));
          for (const h of await scanRecentMessages(store, sessions, q, ctx.signal)) if (!seen.has(h.messageId)) hits.push(h);
        }
        return conversationResults(q, hits.filter((h) => h.role === "user" || h.role === "assistant"),
          (h) => {
            const s = byId.get(h.sessionId);
            return { key: h.sessionId, text: h.content, ts: h.ts, messageId: h.messageId, role: h.role, author: h.role === "user" ? "You" : (s?.agent ?? "Polpo") };
          },
          (id) => {
            const s = byId.get(id);
            return s ? { title: chatTitle(s), subtitle: chatSubtitle(s), url: `/chat?session=${enc(id)}`, meta: chatMeta(s) } : undefined;
          }, "chat");
      },
    },
    {
      type: "room",
      ttlMs: 15_000,
      docs: async () => (await roomsNow()).rooms.map((r) => ({
        type: "room" as const, id: r.id, title: r.title || "Group", subtitle: r.agents.length ? `Group with ${r.agents.join(", ")}` : "Group",
        keywords: r.agents.join(" "), url: `/chat?room=${enc(r.id)}`, updatedAt: r.updatedAt, meta: { agents: r.agents },
      })),
      query: async (q) => {
        const { rooms, messages } = await roomsNow();
        const byId = new Map(rooms.map((r) => [r.id, r]));
        return conversationResults(q, messages,
          (m) => ({ key: m.roomId, text: m.text ?? "", ts: m.ts, messageId: m.id, author: m.authorName || m.authorId }),
          (id) => {
            const r = byId.get(id);
            return r ? { title: r.title || "Group", subtitle: r.agents.length ? `Group with ${r.agents.join(", ")}` : "Group", url: `/chat?room=${enc(id)}`, meta: { agents: r.agents } } : undefined;
          }, "room");
      },
    },
    {
      type: "agent",
      docs: async () => arr(await deps.api("/agents")).map((a: any) => ({
        type: "agent" as const, id: a.name, title: str(a.identity?.displayName) || a.name,
        subtitle: [str(a.role), str(a.identity?.title)].filter(Boolean).join(" · ") || undefined,
        keywords: [a.name, a.model, ...(Array.isArray(a.skills) ? a.skills : [])].filter(Boolean).join(" "),
        body: clip(str(a.identity?.bio) ?? str(a.identity?.personality) ?? "", 2000) || undefined,
        url: `/agents/${enc(a.name)}`, updatedAt: str(a.updatedAt),
        meta: { agent: a.name, role: str(a.role) ?? null, model: str(a.model) ?? null, avatar: str(a.identity?.avatar) ?? null, status: str(a.status) ?? null },
      })),
    },
    {
      type: "task",
      ttlMs: 10_000,
      docs: async () => (await deps.tasks()).map((t) => ({
        type: "task" as const, id: t.id, title: t.title || t.id, subtitle: [t.assignTo, t.group].filter(Boolean).join(" · ") || undefined,
        keywords: t.id, body: clip(t.description, 3000) || undefined, url: `/tasks/${enc(t.id)}`, updatedAt: t.updatedAt ?? t.createdAt,
        meta: { status: t.status, agent: t.assignTo ?? null, ...(t.missionId ? { missionId: t.missionId } : {}), ...(t.group ? { group: t.group } : {}) },
      })),
    },
    {
      type: "mission",
      ttlMs: 10_000,
      docs: async () => (await deps.missions()).map((m) => ({
        type: "mission" as const, id: m.id, title: m.name || m.id, keywords: m.id,
        body: clip(`${m.prompt ?? ""} ${plainText(clip(m.data, 6000))}`, 4000).trim() || undefined,
        url: `/missions/${enc(m.id)}`, updatedAt: m.updatedAt ?? m.createdAt, meta: { status: m.status },
      })),
    },
    {
      type: "schedule",
      docs: async () => {
        const [schedules, missions] = await Promise.all([deps.api("/schedules"), deps.missions().catch(() => [])]);
        const names = new Map(missions.map((m) => [m.id, m.name]));
        return arr(schedules).map((s: any) => ({
          type: "schedule" as const, id: s.id, title: names.get(s.missionId) ?? s.missionId ?? s.id,
          subtitle: `${s.expression ?? ""}${s.nextRunAt ? ` · next ${String(s.nextRunAt).slice(0, 16).replace("T", " ")}` : ""}`.trim() || undefined,
          keywords: `${s.missionId ?? ""} schedule`, url: "/schedules", updatedAt: str(s.lastRunAt) ?? str(s.createdAt),
          meta: { status: s.enabled === false || s.paused ? "paused" : "active", expression: s.expression ?? null, nextRunAt: s.nextRunAt ?? null, missionId: s.missionId ?? null },
        }));
      },
    },
    {
      type: "playbook",
      docs: async () => arr(await deps.api("/playbooks")).map((p: any) => ({
        type: "playbook" as const, id: p.name, title: p.name, body: clip(str(p.description), 2000) || undefined,
        keywords: arr(p.parameters).map((x: any) => x.name).join(" "), url: `/playbooks/${enc(p.name)}`,
      })),
    },
    {
      type: "approval",
      ttlMs: 10_000,
      docs: async () => arr(await deps.api("/approvals?status=all")).map((a: any) => ({
        type: "approval" as const, id: a.id, title: str(a.title) ?? str(a.gateName) ?? str(a.toolName) ?? a.id,
        subtitle: [str(a.agent) ?? str(a.agentName), str(a.status)].filter(Boolean).join(" · ") || undefined,
        body: clip(str(a.description) ?? str(a.reason) ?? str(a.message), 2000) || undefined,
        url: "/approvals", updatedAt: str(a.resolvedAt) ?? str(a.createdAt), meta: { status: str(a.status) ?? null, ...(a.taskId ? { taskId: a.taskId } : {}) },
      })),
    },
    {
      type: "artifact",
      ttlMs: 20_000,
      docs: async () => {
        const store = deps.artifacts();
        if (!store) return [];
        const list = (await store.list()).slice(0, 400);
        // the content of new or changed artifacts (a few at a time)
        const stale = list.filter((a) => artifactText.get(a.id)?.updatedAt !== a.updatedAt);
        for (let i = 0; i < stale.length; i += 8) {
          await Promise.all(stale.slice(i, i + 8).map(async (s) => {
            const full = await store.get(s.id).catch(() => undefined);
            // a large content (a blob) is indexed by its excerpt: never read whole here
            const text = full?.blob ? full.excerpt ?? "" : full?.content ?? "";
            artifactText.set(s.id, { updatedAt: s.updatedAt, text: text ? clip(plainText(clip(text, 60_000)), 20_000) : "" });
          }));
        }
        return list.map((a: any) => ({
          type: "artifact" as const, id: a.id, title: a.title || a.id,
          subtitle: [a.type, a.kind].filter(Boolean).join(" · ") || undefined,
          keywords: [a.description, a.createdBy].filter(Boolean).join(" "),
          body: artifactText.get(a.id)?.text || undefined,
          url: `/artifacts/${enc(a.id)}`, updatedAt: a.updatedAt,
          meta: { artifactType: a.type, ...(a.kind ? { kind: a.kind } : {}), version: a.version ?? null, createdBy: a.createdBy ?? null },
        }));
      },
    },
    {
      type: "file",
      ttlMs: 60_000,
      docs: async () => {
        const { roots, base } = deps.files();
        return walkFiles(roots, base);
      },
    },
    {
      type: "data",
      ttlMs: 60_000,
      docs: async () => {
        const [sources, views] = await Promise.all([deps.api("/data"), deps.api("/views")]);
        const list = arr(sources);
        const docs: SearchDoc[] = list.map((s: any) => ({
          type: "data" as const, id: `source:${s.id}`, title: s.name || s.slug || s.id, subtitle: `${s.kind ?? "data"} source`,
          keywords: [s.slug, ...(Array.isArray(s.tags) ? s.tags : [])].filter(Boolean).join(" "),
          body: clip(str(s.description), 2000) || undefined, url: `/data?source=${enc(s.id)}`, updatedAt: str(s.updatedAt),
          meta: { kind: "source", sourceKind: s.kind ?? null },
        }));
        for (const v of arr(views)) {
          const view = v as any;
          docs.push({
            type: "data", id: `view:${view.id}`, title: view.name || view.title || view.id, subtitle: "View",
            body: clip(str(view.description), 1000) || undefined, url: `/artifacts/${enc(`view:${view.id}`)}`, updatedAt: str(view.updatedAt),
            meta: { kind: "view" },
          });
        }
        // tables and their columns (discovery may be slow: a second per source at most)
        const schemas = await Promise.all(list.slice(0, 20).map((s: any) => Promise.race([
          deps.api(`/data/${enc(s.id)}/schema`).then((d) => ({ source: s, tables: arr(d) })),
          new Promise<{ source: any; tables: any[] }>((resolve) => setTimeout(() => resolve({ source: s, tables: [] }), 1000)),
        ])));
        for (const { source, tables } of schemas) {
          for (const t of tables.slice(0, 200)) {
            const columns = arr(t.columns).map((c: any) => String(c.name)).slice(0, 40);
            docs.push({
              type: "data", id: `table:${source.id}:${t.name}`, title: t.name, subtitle: `Table in ${source.name ?? source.id}`,
              keywords: columns.join(" "), url: `/data?source=${enc(source.id)}&table=${enc(t.name)}`,
              meta: { kind: "table", columns, sourceId: source.id },
            });
          }
        }
        return docs;
      },
    },
    {
      type: "connector",
      docs: async () => arr(await deps.api("/connectors"), "connectors").map((c: any) => ({
        type: "connector" as const, id: c.id, title: c.name || c.id, subtitle: c.description ? clip(c.description, 140) : undefined,
        keywords: [c.id, c.catalogId, c.kind].filter(Boolean).join(" "), url: "/connectors", updatedAt: str(c.updatedAt) ?? str(c.createdAt),
        meta: { status: c.enabled === false ? "disabled" : "enabled", kind: c.kind ?? null },
      })),
    },
    {
      type: "skill",
      ttlMs: 60_000,
      docs: async () => arr(await deps.api("/skills")).map((s: any) => ({
        type: "skill" as const, id: s.name, title: s.name, body: clip(str(s.description), 1500) || undefined,
        keywords: arr<string>(s.assignedTo ?? s.agents).join(" "), url: `/skills/${enc(s.name)}`,
      })),
    },
    {
      type: "memory",
      ttlMs: 30_000,
      docs: async () => {
        const docs: SearchDoc[] = [];
        const shared = (await deps.api("/memory")) as { content?: string } | undefined;
        if (shared?.content) docs.push({ type: "memory", id: "shared", title: "Shared memory", subtitle: "Every agent reads it", body: clip(shared.content, 60_000), url: "/memory", meta: { scope: "shared" } });
        const agents = arr(await deps.api("/agents")).map((a: any) => String(a.name)).slice(0, 60);
        const own = await Promise.all(agents.map(async (name) => ({ name, mem: (await deps.api(`/memory/agent/${enc(name)}`)) as { content?: string } | undefined })));
        for (const { name, mem } of own) {
          if (mem?.content) docs.push({ type: "memory", id: `agent:${name}`, title: `Memory of ${name}`, subtitle: name, body: clip(mem.content, 30_000), url: `/memory?agent=${enc(name)}`, meta: { scope: "agent", agent: name } });
        }
        return docs;
      },
    },
    {
      type: "brain",
      query: async (q) => {
        const text = q.terms.map((t) => t.text).join(" ");
        const now = Date.now();
        return arr(await deps.api(`/brain/search?q=${enc(text)}`)).slice(0, 40).map((e: any) => toResult({
          type: "brain", id: e.id, title: e.name || e.id, subtitle: [e.type, e.status].filter(Boolean).join(" · ") || undefined,
          keywords: [...arr<string>(e.aliases), ...arr<string>(e.tags)].join(" "),
          body: clip(Object.values(e.properties ?? {}).filter((v) => typeof v === "string").join(" "), 3000) || undefined,
          url: `/brain?entity=${enc(e.id)}`, updatedAt: str(e.updatedAt), meta: { entityType: e.type ?? null },
        }, q, now)).filter((r): r is SearchResult => !!r);
      },
    },
    {
      type: "computer",
      ttlMs: 60_000,
      docs: async () => arr(await deps.api("/computers"), "computers").map((c: any) => ({
        type: "computer" as const, id: c.id, title: c.name || c.id, subtitle: [c.kind, c.status].filter(Boolean).join(" · ") || undefined,
        keywords: [c.id, ...arr(c.agents).map((a: any) => a.name)].join(" "), url: `/computers/${enc(c.id)}`,
        meta: { status: c.status ?? null, kind: c.kind ?? null },
      })),
    },
    {
      type: "app",
      docs: async () => arr(await deps.api("/apps")).map((a: any) => ({
        type: "app" as const, id: a.id, title: a.name || a.slug || a.id,
        subtitle: arr(a.domains).map((d: any) => d.hostname).filter(Boolean).slice(0, 2).join(", ") || undefined,
        keywords: [a.slug, ...arr<string>(a.tags)].filter(Boolean).join(" "), body: clip(str(a.description), 1000) || undefined,
        url: `/apps/${enc(a.id)}`, updatedAt: str(a.updatedAt),
      })),
    },
    {
      type: "channel",
      docs: async () => {
        const config = (await deps.api("/config")) as { settings?: { notifications?: { channels?: Record<string, any> } } } | undefined;
        return Object.entries(config?.settings?.notifications?.channels ?? {}).map(([name, ch]) => ({
          type: "channel" as const, id: name, title: name, subtitle: [ch?.type, ch?.gateway?.agent ? `for ${ch.gateway.agent}` : undefined].filter(Boolean).join(" · ") || undefined,
          keywords: `${ch?.type ?? ""} channel`, url: "/config?section=channels", meta: { channelType: ch?.type ?? null },
        }));
      },
    },
    {
      type: "member",
      docs: async () => arr(await deps.api("/auth/instance/members"), "members").map((m: any) => ({
        type: "member" as const, id: m.email ?? m.id, title: str(m.name) || m.email, subtitle: str(m.name) ? m.email : str(m.role),
        keywords: [m.email, m.role].filter(Boolean).join(" "), url: "/config?section=members", meta: { role: str(m.role) ?? null },
      })),
    },
    {
      type: "event",
      ttlMs: 3_000,
      docs: async () => deps.recentEvents()
        .filter((e) => !NOISY_EVENT.test(e.event))
        .slice(-400)
        .map((e) => {
          const s = eventSummary(e.data);
          return {
            type: "event" as const, id: e.id, title: e.event, subtitle: s.text || undefined, keywords: e.event.replace(/[:._-]/g, " "),
            url: s.url, updatedAt: new Date(e.ts).toISOString(), meta: { event: e.event, ...(s.agent ? { agent: s.agent } : {}) },
          };
        }),
    },
  ];
  return sources;
}
