/**
 * The palette's preview (desktop, on the right): more about the selected result, loaded when it is
 * selected — a chat's matching message in its context, a task's status, agent, last run and cost,
 * a mission's, an agent's role and model, an artifact or a file's first lines, a table's columns.
 */
import { useEffect, useState, type ReactNode } from "react";
import { usePolpo, type SearchResult } from "@polpo-ai/react";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { apiFetch, apiUrl } from "@/lib/config";
import { foldText, shortAge } from "@/lib/global-search";
import { taskCostSummaryOf } from "@/lib/task-cost";
import { cn } from "@/lib/utils";
import { Highlighted, StatusBadge, iconFor } from "./search-parts";
import type { PaletteEntry } from "./search-palette";

/** Ranges where the query's words start words of a text (local, for the preview's messages). */
export function termRanges(text: string, query: string): Array<[number, number]> {
  const terms = foldText(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!terms.length) return [];
  const folded = foldText(text);
  // folding may change lengths (ligatures): only highlight when it did not
  if (folded.length !== text.length) return [];
  const out: Array<[number, number]> = [];
  for (const m of folded.matchAll(/[\p{L}\p{N}]+/gu)) {
    const t = terms.find((term) => m[0].startsWith(term.length > 4 ? term.slice(0, -1) : term));
    if (t) out.push([m.index ?? 0, (m.index ?? 0) + Math.min(m[0].length, t.length)]);
    if (out.length > 40) break;
  }
  return out;
}

/** Load something for the selected result (cancelled when the selection moves on). */
function useLoad<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): { data?: T; loading: boolean; error?: string } {
  const [state, setState] = useState<{ key: string | null; data?: T; loading: boolean; error?: string }>({ key: null, loading: false });
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    setState({ key, loading: true });
    // a short pause: arrowing through the list does not fire a request per row
    const timer = setTimeout(() => {
      load(controller.signal).then(
        (data) => { if (!controller.signal.aborted) setState({ key, data, loading: false }); },
        (err: Error) => { if (!controller.signal.aborted) setState({ key, loading: false, error: err?.message ?? "Could not load" }); },
      );
    }, 90);
    return () => { clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { loading: !!key };
}

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const res = await apiFetch(apiUrl(path), { signal });
  const body = await res.json().catch(() => null) as { ok?: boolean; data?: T; error?: string } | null;
  if (!res.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body.data as T;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-foreground">{children}</span>
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-2" aria-label="Loading preview">
      {[80, 60, 70].map((w) => <div key={w} className="h-3 animate-pulse rounded-xs bg-muted" style={{ width: `${w}%` }} />)}
    </div>
  );
}

function ChatPreview({ result, query }: { result: SearchResult; query: string }) {
  const { client } = usePolpo();
  const messageId = typeof result.meta?.messageId === "string" ? result.meta.messageId : undefined;
  const { data, loading } = useLoad(result.type === "chat" ? `chat:${result.id}:${messageId ?? ""}` : null, () => client.getSessionMessages(result.id));
  if (result.type !== "chat") return result.snippet ? <Snippet result={result} /> : null;
  if (loading && !data) return <Loading />;
  const messages = (data?.messages ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim());
  let at = messageId ? messages.findIndex((m) => m.id === messageId) : -1;
  if (at < 0) at = messages.length - 1;
  const around = messages.slice(Math.max(0, at - 2), at + 3);
  if (!around.length) return result.snippet ? <Snippet result={result} /> : null;
  const agent = typeof result.meta?.agent === "string" ? result.meta.agent : undefined;
  return (
    <div className="space-y-2">
      {around.map((m) => {
        const hit = m.id === messageId;
        const text = String(m.content).replace(/\s+/g, " ").slice(0, hit ? 600 : 220);
        return (
          <div key={m.id} className={cn("rounded-control border px-2.5 py-2", hit ? "border-primary/40 bg-primary/5" : "border-border/60 bg-muted/30")}>
            <div className="mb-1 flex items-center justify-between gap-2 text-micro text-muted-foreground">
              <span className="font-medium text-foreground/80">{m.role === "user" ? "You" : (agent ?? "Polpo")}</span>
              <span>{shortAge(typeof m.ts === "string" ? m.ts : undefined)}</span>
            </div>
            <p className="text-xs leading-relaxed text-foreground/90">
              <Highlighted text={text} ranges={hit ? termRanges(text, query) : undefined} />
            </p>
          </div>
        );
      })}
    </div>
  );
}

function Snippet({ result }: { result: SearchResult }) {
  if (!result.snippet) return null;
  return (
    <p className="rounded-control border border-border/60 bg-muted/30 px-2.5 py-2 text-xs leading-relaxed text-foreground/90">
      {typeof result.meta?.author === "string" && <span className="font-medium text-foreground">{result.meta.author}: </span>}
      <Highlighted text={result.snippet.text} ranges={result.snippet.highlights} />
    </p>
  );
}

function TaskPreview({ result }: { result: SearchResult }) {
  const { client } = usePolpo();
  const { data: task, loading } = useLoad(`task:${result.id}`, () => client.getTask(result.id));
  if (loading && !task) return <Loading />;
  if (!task) return <Snippet result={result} />;
  const lastRun = task.runs?.at(-1);
  const cost = taskCostSummaryOf(task);
  return (
    <div className="space-y-3">
      <div>
        <Row label="Status"><StatusBadge kind="task" status={task.status} /></Row>
        <Row label="Agent">{task.assignTo || "—"}</Row>
        {lastRun && <Row label="Last run">{`${shortAge(lastRun.endedAt ?? lastRun.startedAt)} · ${lastRun.status}`}</Row>}
        {cost && cost.usd > 0 && <Row label="Cost">{`$${cost.usd.toFixed(cost.usd < 1 ? 3 : 2)} · ${cost.runs} run${cost.runs === 1 ? "" : "s"}`}</Row>}
        <Row label="Updated">{shortAge(task.updatedAt)}</Row>
      </div>
      {task.description && <p className="line-clamp-6 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">{task.description.slice(0, 700)}</p>}
    </div>
  );
}

function MissionPreview({ result }: { result: SearchResult }) {
  const { client } = usePolpo();
  const { data: mission, loading } = useLoad(`mission:${result.id}`, () => client.getMission(result.id));
  if (loading && !mission) return <Loading />;
  if (!mission) return <Snippet result={result} />;
  let tasks = 0;
  try { tasks = (JSON.parse(mission.data ?? "{}")?.tasks ?? []).length; } catch { /* not JSON */ }
  const usd = (mission as { cost?: { usd?: number } }).cost?.usd;
  return (
    <div className="space-y-3">
      <div>
        <Row label="Status"><StatusBadge kind="mission" status={mission.status} /></Row>
        {tasks > 0 && <Row label="Tasks">{tasks}</Row>}
        {typeof usd === "number" && usd > 0 && <Row label="Cost">{`$${usd.toFixed(2)}`}</Row>}
        {mission.schedule && <Row label="Schedule">{mission.schedule}</Row>}
        <Row label="Updated">{shortAge(mission.updatedAt)}</Row>
      </div>
      {mission.prompt && <p className="line-clamp-6 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">{mission.prompt.slice(0, 700)}</p>}
    </div>
  );
}

function AgentPreview({ result }: { result: SearchResult }) {
  const { client } = usePolpo();
  const { data: agent, loading } = useLoad(`agent:${result.id}`, () => client.getAgent(result.id));
  if (loading && !agent) return <Loading />;
  const a = agent as (typeof agent & { identity?: { avatar?: string; displayName?: string; title?: string; bio?: string; color?: unknown } }) | undefined;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <AgentAvatar avatar={a?.identity?.avatar} name={result.id} color={a?.identity?.color} size="lg" fallbackVariant="circle" shape="circle" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{a?.identity?.displayName ?? result.title}</p>
          <p className="truncate text-xs text-muted-foreground">{a?.role ?? a?.identity?.title ?? result.subtitle}</p>
        </div>
      </div>
      <div>
        <Row label="Name">{result.id}</Row>
        {a?.model && <Row label="Model">{a.model}</Row>}
        {typeof result.meta?.status === "string" && <Row label="Status"><StatusBadge kind="agent" status={result.meta.status} /></Row>}
        {a?.skills?.length ? <Row label="Skills">{a.skills.length}</Row> : null}
        {a?.reportsTo && <Row label="Reports to">{a.reportsTo}</Row>}
      </div>
      {a?.identity?.bio && <p className="line-clamp-5 text-xs leading-relaxed text-muted-foreground">{a.identity.bio}</p>}
    </div>
  );
}

function ArtifactPreview({ result }: { result: SearchResult }) {
  const { data, loading } = useLoad(`artifact:${result.id}`, (signal) => getJson<{ type: string; content?: string; description?: string; version?: number }>(`/api/v1/artifacts/${encodeURIComponent(result.id)}`, signal));
  if (loading && !data) return <Loading />;
  if (!data) return <Snippet result={result} />;
  const content = data.content ?? "";
  return (
    <div className="space-y-3">
      {data.type === "svg" && content ? (
        <img alt={result.title} className="max-h-48 w-full rounded-control border border-border/60 bg-card object-contain" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`} />
      ) : data.type === "html" && content ? (
        // no scripts, no network: a still thumbnail of the page
        <iframe title={result.title} sandbox="" srcDoc={content} className="pointer-events-none h-48 w-full rounded-control border border-border/60 bg-card" />
      ) : (
        <pre className="max-h-56 overflow-hidden whitespace-pre-wrap rounded-control border border-border/60 bg-muted/30 p-2.5 font-mono text-micro leading-relaxed text-foreground/80">{content.slice(0, 1200)}</pre>
      )}
      <Row label="Type">{[data.type, result.meta?.kind].filter(Boolean).join(" · ")}</Row>
      {data.version ? <Row label="Version">{data.version}</Row> : null}
      {result.snippet && <Snippet result={result} />}
    </div>
  );
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;
const BINARY = /\.(pdf|zip|gz|tar|mp4|mov|mp3|wav|woff2?|ttf|otf|exe|bin|db|sqlite|xlsx?|docx?|pptx?)$/i;

function FilePreview({ result }: { result: SearchResult }) {
  const path = String(result.meta?.path ?? result.id);
  const isDir = result.meta?.kind === "directory";
  const image = IMAGE.test(path);
  const skip = isDir || (!image && BINARY.test(path));
  const { data, loading } = useLoad(skip ? null : `file:${path}`, async (signal) => {
    const res = await apiFetch(apiUrl(`/api/v1/files/read?path=${encodeURIComponent(path)}`), { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (image) return { url: URL.createObjectURL(await res.blob()) };
    const text = await res.text();
    return { text: text.split("\n").slice(0, 40).join("\n").slice(0, 3000) };
  });
  useEffect(() => () => { if (data && "url" in data && data.url) URL.revokeObjectURL(data.url); }, [data]);
  return (
    <div className="space-y-3">
      {loading && !data ? <Loading /> : data && "url" in data ? (
        <img alt={result.title} src={data.url} className="max-h-56 w-full rounded-control border border-border/60 bg-card object-contain" />
      ) : data && "text" in data ? (
        <pre className="max-h-64 overflow-hidden whitespace-pre-wrap rounded-control border border-border/60 bg-muted/30 p-2.5 font-mono text-micro leading-relaxed text-foreground/80">{data.text || "(empty file)"}</pre>
      ) : null}
      <Row label="Folder">{String(result.meta?.folder ?? "")}</Row>
      <Row label="Kind">{isDir ? "Folder" : "File"}</Row>
    </div>
  );
}

function DataPreview({ result }: { result: SearchResult }) {
  const columns = Array.isArray(result.meta?.columns) ? (result.meta.columns as string[]) : [];
  return (
    <div className="space-y-3">
      <Row label="Kind">{String(result.meta?.kind ?? "data")}</Row>
      {columns.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs text-muted-foreground">Columns</p>
          <div className="flex flex-wrap gap-1">
            {columns.map((c) => <span key={c} className="rounded-badge border border-border/60 bg-muted/40 px-1.5 py-px font-mono text-micro text-foreground/80">{c}</span>)}
          </div>
        </div>
      )}
      <Snippet result={result} />
    </div>
  );
}

function GenericPreview({ result }: { result: SearchResult }) {
  const meta = Object.entries(result.meta ?? {}).filter(([k, v]) => ["status", "kind", "role", "expression", "nextRunAt", "channelType", "entityType", "scope"].includes(k) && v != null && v !== "");
  return (
    <div className="space-y-3">
      <div>
        {meta.map(([k, v]) => (
          <Row key={k} label={k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())}>
            {k === "status" ? <StatusBadge kind={result.type} status={v} /> : String(v)}
          </Row>
        ))}
        {result.updatedAt && <Row label="Updated">{shortAge(result.updatedAt)}</Row>}
      </div>
      <Snippet result={result} />
    </div>
  );
}

export function SearchPreview({ entry, query }: { entry: PaletteEntry | undefined; query: string }) {
  if (!entry) {
    return <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">Select a result to see more.</div>;
  }
  const Icon = entry.icon ?? iconFor(entry.kind, entry.result?.meta);
  const r = entry.result;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-2.5 border-b border-border/60 px-4 py-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-muted text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="break-words text-sm font-semibold leading-snug">{entry.title}</p>
          {entry.subtitle && <p className="truncate text-xs text-muted-foreground">{entry.subtitle}</p>}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!r ? (
          <p className="text-xs text-muted-foreground">{entry.hint ?? entry.subtitle ?? ""}</p>
        ) : r.type === "chat" || r.type === "room" ? (
          <ChatPreview result={r} query={query} />
        ) : r.type === "task" ? (
          <TaskPreview result={r} />
        ) : r.type === "mission" ? (
          <MissionPreview result={r} />
        ) : r.type === "agent" ? (
          <AgentPreview result={r} />
        ) : r.type === "artifact" ? (
          <ArtifactPreview result={r} />
        ) : r.type === "file" ? (
          <FilePreview result={r} />
        ) : r.type === "data" ? (
          <DataPreview result={r} />
        ) : (
          <GenericPreview result={r} />
        )}
      </div>
      {entry.url && <div className="border-t border-border/60 px-4 py-2 font-mono text-micro text-muted-foreground/80 truncate">{entry.url}</div>}
    </div>
  );
}
