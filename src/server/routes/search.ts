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
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { SEARCH_TYPES, isSearchType, type SearchEngine, type SearchType } from "../search/engine.js";

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

export function searchRoutes(getEngine: () => SearchEngine | undefined): OpenAPIHono {
  const app = new OpenAPIHono();

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
