/**
 * polpo_search: the global search (GET /api/v1/search), the same as ⌘K in the dashboard.
 */
import { z } from "zod";
import { SEARCH_TYPES } from "../search/engine.js";
import { READ, apiError, apiGet, ok, qs, type McpDeps, type Register } from "./kit.js";

interface Hit {
  type: string;
  id: string;
  title: string;
  subtitle?: string;
  snippet?: { text: string; highlights: Array<[number, number]> };
  url: string;
  updatedAt?: string;
  meta?: Record<string, unknown>;
}
interface Page {
  groups: Array<{ type: string; label: string; total: number; items: Hit[] }>;
  partial: string[];
  nextCursor: string | null;
}

/** A snippet with its matches in **bold**, on one line. */
function bolded(s: { text: string; highlights: Array<[number, number]> }): string {
  let out = "";
  let at = 0;
  for (const [a, b] of s.highlights) {
    if (a < at) continue;
    out += `${s.text.slice(at, a)}**${s.text.slice(a, b)}**`;
    at = b;
  }
  return (out + s.text.slice(at)).replace(/\s+/g, " ");
}

/** What identifies the item for the other tools (task id, agent name, session id…). */
function handle(h: Hit): string {
  const meta = h.meta ?? {};
  if (h.type === "chat") return `session ${h.id}${meta.messageId ? `, message ${meta.messageId}` : ""}`;
  if (h.type === "room") return `room ${h.id}`;
  if (h.type === "file") return String(meta.path ?? h.id);
  return h.id;
}

export function registerSearchTools(tool: Register, deps: McpDeps): void {
  const item = z.object({
    type: z.string(), id: z.string(), title: z.string(), subtitle: z.string().optional(),
    snippet: z.object({ text: z.string(), highlights: z.array(z.array(z.number())) }).passthrough().optional(),
    url: z.string(), updatedAt: z.string().optional(), score: z.number().optional(), meta: z.record(z.string(), z.unknown()).optional(),
  }).passthrough();

  tool("core", "polpo_search", {
    title: "Search everything",
    description: "Search the whole instance at once, as ⌘K does in the dashboard: chats (the text of their messages too, with who said it), "
      + "groups, agents, tasks, missions, schedules, playbooks, approvals, artifacts (their content too), files (by name), data sources, views and tables, "
      + "connectors, skills, memory, the company brain, computers, apps, channels, members and recent events. Results come grouped by type, best first: "
      + "a title equal to or starting with the words, then recent items, then content matches. Words match as prefixes, without accents, "
      + "plurals folded, one typo forgiven in longer words. Use it to find where something was said or which item the person means, "
      + "then read it with the area's own tool (polpo_chat_messages, polpo_task_get, polpo_artifact_get…). Secrets are never searched or shown.",
    inputSchema: {
      q: z.string().min(1).max(200).describe("Words to find, e.g. 'invoice march' or 'deploy failed'"),
      types: z.array(z.enum(SEARCH_TYPES)).optional().describe("Only these types (default: all)"),
      limit: z.number().int().min(1).max(100).optional().describe("Most results (default 30)"),
      per_type: z.number().int().min(1).max(50).optional().describe("Most results per type when several types are searched (default 6)"),
      cursor: z.string().optional().describe("next_cursor of the previous call"),
    },
    outputSchema: {
      groups: z.array(z.object({ type: z.string(), label: z.string(), total: z.number(), items: z.array(item) }).passthrough()),
      partial: z.array(z.string()).describe("Types that did not answer in time: search again for them"),
      next_cursor: z.string().nullable(),
    },
    annotations: READ,
  }, async ({ q, types, limit, per_type, cursor }) => {
    const r = await apiGet(deps, `/search${qs({ q, types: types?.join(","), limit: limit ?? 30, perType: per_type, cursor })}`);
    if (!r.ok) return apiError(r, "The search");
    const data = r.data as Page;
    const lines: string[] = [];
    for (const g of data.groups) {
      lines.push(`## ${g.label} (${g.total > g.items.length ? `${g.items.length} of ${g.total}` : g.items.length})`);
      for (const h of g.items) {
        const meta = h.meta ?? {};
        const extra = [h.subtitle, typeof meta.status === "string" ? meta.status : undefined, h.updatedAt ? h.updatedAt.slice(0, 16).replace("T", " ") : undefined].filter(Boolean).join(" · ");
        lines.push(`- ${h.title}${extra ? ` (${extra})` : ""} [${handle(h)}]`);
        if (h.snippet?.text) lines.push(`  ${typeof meta.author === "string" ? `${meta.author}: ` : ""}${bolded(h.snippet)}`);
      }
    }
    if (data.partial.length) lines.push(`(Still loading: ${data.partial.join(", ")}. Search again in a moment for them.)`);
    if (data.nextCursor) lines.push(`(More: cursor ${data.nextCursor})`);
    return ok(lines.join("\n") || `Nothing found for "${q}".`, { groups: data.groups, partial: data.partial, next_cursor: data.nextCursor });
  });
}
