/**
 * GET /api/v1/search — the global search (dashboard ⌘K, polpo_search, Polpo's search tool).
 *
 *   ?q=        words to find (empty: nothing, and the sources warm up for the next query)
 *   ?types=    chat,agent,task… (default: every type)
 *   ?limit=    results per page (default 40, max 100)
 *   ?perType=  results per type when several are searched (default 6)
 *   ?cursor=   the previous page's nextCursor
 *
 * Results are grouped by type, best first. A client that types fast aborts the previous
 * request: the search notices (the request's signal) and stops.
 *
 * POST /api/v1/search/ask — ask Polpo (the orchestrator's model) from the palette: an answer, the
 * results worth opening and what to do (open a page, run a view command, or a button that hands a
 * change to a new Polpo chat). JSON, or Server-Sent Events with stream: true (src/server/search/ask.ts).
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { SEARCH_TYPES, isSearchType, type SearchEngine, type SearchType } from "../search/engine.js";
import { AskError, runSearchAsk, type AskEvent, type AskRequest, type AskUsage } from "../search/ask.js";
import type { AskModel } from "../search/ask-llm.js";

const RangeSchema = z.tuple([z.number(), z.number()]);
const ResultSchema = z.object({
  type: z.enum(SEARCH_TYPES),
  id: z.string(),
  title: z.string(),
  titleHighlights: z.array(RangeSchema).optional().openapi({ description: "Matched [start, end) ranges in the title" }),
  subtitle: z.string().optional(),
  snippet: z.object({ text: z.string(), highlights: z.array(RangeSchema) }).optional()
    .openapi({ description: "The matching passage (secrets masked) and its matched [start, end) ranges" }),
  url: z.string().openapi({ description: "Dashboard route that opens the item" }),
  updatedAt: z.string().optional(),
  score: z.number(),
  meta: z.record(z.string(), z.unknown()).optional().openapi({ description: "Type details: agent, status, messageId, author, columns…" }),
}).openapi("SearchResult");

const searchRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Search"],
  summary: "Search everything",
  description: "Search chats (message text included), groups, agents, tasks, missions, schedules, playbooks, approvals, artifacts, files, "
    + "data, connectors, skills, memory, the company brain, computers, apps, channels, members and recent events. Results are grouped by type; "
    + "words match as prefixes, without diacritics, plurals folded, one typo forgiven in longer words. Vault values and tokens are never searched or shown.",
  request: {
    query: z.object({
      q: z.string().optional().openapi({ description: "Words to find" }),
      types: z.string().optional().openapi({ description: `Comma-separated types: ${SEARCH_TYPES.join(", ")}` }),
      limit: z.string().optional().openapi({ description: "Results per page (default 40, max 100)" }),
      perType: z.string().optional().openapi({ description: "Results per type when several types are searched (default 6)" }),
      cursor: z.string().optional().openapi({ description: "nextCursor of the previous page" }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              query: z.string(),
              took: z.number(),
              partial: z.array(z.enum(SEARCH_TYPES)),
              groups: z.array(z.object({ type: z.enum(SEARCH_TYPES), label: z.string(), total: z.number(), items: z.array(ResultSchema) })),
              items: z.array(ResultSchema),
              nextCursor: z.string().nullable(),
            }),
          }),
        },
      },
      description: "Results grouped by type",
    },
    400: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Unknown type" },
  },
});

const IntentSchema = z.object({
  kind: z.enum(["navigate", "open", "command", "handoff"]),
  route: z.string().optional().openapi({ description: "navigate / open: the dashboard route" }),
  key: z.string().optional().openapi({ description: "open: the result (type:id)" }),
  id: z.string().optional().openapi({ description: "command: the palette command's id" }),
  argument: z.string().optional(),
  label: z.string(),
  message: z.string().optional().openapi({ description: "handoff: the message for a new Polpo chat" }),
  auto: z.boolean().openapi({ description: "true: the dashboard does it at once (navigation, view-only commands); false: a button the person clicks" }),
}).openapi("SearchAskIntent");

const AskOutcomeSchema = z.object({
  answer: z.string(),
  items: z.array(ResultSchema),
  intents: z.array(IntentSchema),
  fastPath: z.boolean().openapi({ description: "Answered without the model (an obvious \"go to X\")" }),
  rounds: z.number(),
  usage: z.object({
    provider: z.string().optional(), model: z.string().optional(),
    inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number(), cacheWriteTokens: z.number(), totalTokens: z.number(), cost: z.number(),
  }).optional(),
}).openapi("SearchAskResult");

const AskBodySchema = z.object({
  q: z.string().min(1).max(500).openapi({ description: "The question or request, in any words (Italian, English…)" }),
  route: z.string().max(300).optional().openapi({ description: "The page the person is on" }),
  pages: z.array(z.object({ id: z.string().max(80).optional(), label: z.string().max(80), to: z.string().max(300), section: z.string().max(120).optional() }))
    .max(200).optional().openapi({ description: "The dashboard's pages (default: the built-in list)" }),
  commands: z.array(z.object({
    id: z.string().max(80), label: z.string().max(120), hint: z.string().max(200).optional(),
    argument: z.boolean().optional(), confirm: z.boolean().optional().openapi({ description: "Changes data: only ever suggested" }),
  })).max(80).optional().openapi({ description: "The palette's commands the assistant may run or suggest" }),
  stream: z.boolean().optional().openapi({ description: "true: Server-Sent Events (status, delta, results, intent, done, error)" }),
});

const askRoute = createRoute({
  method: "post",
  path: "/ask",
  tags: ["Search"],
  summary: "Ask Polpo from the search",
  description: "Sends the request to the orchestrator's model (settings.orchestratorModel) with the global search as a tool. "
    + "It answers briefly, picks the results worth opening and returns intents: navigation and view-only commands (auto: true) "
    + "that the dashboard runs at once, and buttons (auto: false) for anything that changes data, never run here. "
    + "An obvious \"go to X\" / \"vai a X\" naming a page is answered without the model. With stream: true the answer comes as "
    + "Server-Sent Events whose data is {type: status|delta|results|intent|done|error, …}. Rate limited; bounded rounds, tokens and time.",
  request: { body: { content: { "application/json": { schema: AskBodySchema } }, required: true } },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ ok: z.literal(true), data: AskOutcomeSchema }) },
        "text/event-stream": { schema: z.string().openapi({ description: "data: {type, …} per event, the last one done or error" }) },
      },
      description: "The answer (JSON), or its events (stream: true)",
    },
    502: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string(), code: z.string() }) } }, description: "The model failed or took too long" },
    503: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string(), code: z.string() }) } }, description: "Search not ready, or Polpo's model not configured" },
  },
});

/** What the ask endpoint needs: the orchestrator's model and where its usage is recorded. */
export interface SearchAskRuntime {
  model: () => Promise<AskModel>;
  recordUsage?: (usage: AskUsage) => Promise<void>;
}

export function searchRoutes(getEngine: () => SearchEngine | undefined, getAsk?: () => SearchAskRuntime | undefined): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(askRoute, (async (c: any) => {
    const body = c.req.valid("json") as AskRequest & { stream?: boolean };
    const engine = getEngine();
    if (!engine) return c.json({ ok: false, error: "The search is not ready yet.", code: "NOT_READY" }, 503);
    const req: AskRequest = { q: body.q, ...(body.route ? { route: body.route } : {}), ...(body.pages ? { pages: body.pages } : {}), ...(body.commands ? { commands: body.commands } : {}) };
    const search = (q: string, opts: { types?: SearchType[]; limit: number; signal: AbortSignal }) => engine.search({ q, ...opts, perType: 4 });
    const runtime = getAsk?.();
    const run = async (emit?: (e: AskEvent) => void, signal?: AbortSignal) => {
      // the fast path ("vai a X") needs no model: the model is resolved only when needed
      const fast = await runSearchAsk(req, null, emit, signal).catch((err) => {
        if (err instanceof AskError && err.code === "NO_MODEL") return null;
        throw err;
      });
      if (fast) return fast;
      if (!runtime) throw new AskError("Polpo's model is not available here.", "NO_MODEL");
      const model = await runtime.model();
      const out = await runSearchAsk(req, { llm: model.llm, search, model: { provider: model.provider, id: model.id } }, emit, signal);
      if (out.usage && out.usage.totalTokens > 0) void runtime.recordUsage?.(out.usage).catch(() => undefined);
      return out;
    };

    if (!body.stream) {
      try {
        return c.json({ ok: true, data: await run(undefined, c.req.raw.signal) }, 200);
      } catch (err) {
        const code = err instanceof AskError ? err.code : "LLM_ERROR";
        return c.json({ ok: false, error: err instanceof Error ? err.message : String(err), code }, code === "NO_MODEL" ? 503 : 502);
      }
    }
    return streamSSE(c, async (stream) => {
      // events are written in order; the stream closes once the last one is out
      let written: Promise<void> = Promise.resolve();
      const send = (e: AskEvent) => { written = written.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e) })).catch(() => undefined); };
      try {
        await run(send, c.req.raw.signal);
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : String(err), code: err instanceof AskError ? err.code : "LLM_ERROR" });
      }
      await written;
    });
  }) as any);

  app.openapi(searchRoute, (async (c: any) => {
    const query = c.req.valid("query") as { q?: string; types?: string; limit?: string; perType?: string; cursor?: string };
    const engine = getEngine();
    const q = (query.q ?? "").slice(0, 200);
    const types = (query.types ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    const unknown = types.filter((t) => !isSearchType(t));
    if (unknown.length) return c.json({ ok: false, error: `Unknown type: ${unknown.join(", ")}. Types: ${SEARCH_TYPES.join(", ")}` }, 400);
    if (!engine) return c.json({ ok: true, data: { query: q, took: 0, partial: [], groups: [], items: [], nextCursor: null } }, 200);
    const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
    try {
      const data = await engine.search({
        q,
        types: types as SearchType[],
        limit: num(query.limit),
        perType: num(query.perType),
        cursor: query.cursor,
        signal: c.req.raw.signal,
      });
      return c.json({ ok: true, data }, 200);
    } catch (err) {
      // the client went away (a newer query): nobody reads this answer
      if ((err as Error)?.name === "AbortError") return c.body(null, 499);
      throw err;
    }
  }) as any);

  return app;
}
