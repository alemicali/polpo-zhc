/**
 * Web search tools powered by Exa (exa.ai).
 *
 * Provides semantic web search with optional content extraction.
 * Requires EXA_API_KEY in vault or environment.
 *
 * Tools:
 * - search_web: Search the web with a natural language query
 * - search_find_similar: Find pages similar to a given URL
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ResolvedVault } from "./types.js";

const EXA_BASE = "https://api.exa.ai";
const DEFAULT_NUM_RESULTS = 5;
const DEFAULT_TIMEOUT = 15_000;

// ─── Helpers ───

function getExaApiKey(vault?: ResolvedVault): string | undefined {
  // Try vault first (service "exa", key "key"), then environment
  return vault?.getKey("exa", "key") ?? process.env.EXA_API_KEY;
}

function ok(text: string, details?: Record<string, unknown>) { return { content: [{ type: "text" as const, text }], details: details ?? {} }; }
function err(text: string) { return { content: [{ type: "text" as const, text }], details: { error: true } }; }

interface ExaSearchResult {
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  score?: number;
  text?: string;
  highlights?: string[];
  summary?: string;
}

interface ExaResponse {
  results: ExaSearchResult[];
  autopromptString?: string;
}

function formatResults(results: ExaSearchResult[], withContent: boolean): string {
  if (results.length === 0) return "(no results)";

  return results.map((r, i) => {
    const parts = [`${i + 1}. **${r.title}**`, `   ${r.url}`];
    if (r.publishedDate) parts.push(`   Published: ${r.publishedDate}`);
    if (r.author) parts.push(`   Author: ${r.author}`);
    if (r.summary) {
      parts.push(`   Summary: ${r.summary}`);
    } else if (withContent && r.text) {
      // Truncate content to avoid token bloat
      const text = r.text.length > 1500 ? r.text.slice(0, 1500) + "..." : r.text;
      parts.push(`   Content: ${text}`);
    }
    if (r.highlights?.length) {
      parts.push(`   Highlights:`);
      for (const h of r.highlights.slice(0, 3)) {
        parts.push(`     - ${h}`);
      }
    }
    return parts.join("\n");
  }).join("\n\n");
}

// ─── Tool: search_web ───

const SearchWebSchema = Type.Object({
  query: Type.String({ description: "Natural language search query. Be descriptive — Exa uses semantic search, not keywords." }),
  numResults: Type.Optional(Type.Number({ description: `Number of results to return (default: ${DEFAULT_NUM_RESULTS}, max: 20)` })),
  includeContent: Type.Optional(Type.Boolean({ description: "Include page content/summary in results (default: true). Costs more but saves a follow-up http_fetch." })),
  includeDomains: Type.Optional(Type.Array(Type.String(), { description: "Only return results from these domains (e.g. ['github.com', 'docs.python.org'])" })),
  excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Exclude results from these domains" })),
  startPublishedDate: Type.Optional(Type.String({ description: "Only results published after this date (ISO format, e.g. '2024-01-01')" })),
  category: Type.Optional(Type.String({ description: "Filter by category: company, research_paper, news, pdf, github, tweet, personal_site, linkedin_profile" })),
});

function createSearchWebTool(vault?: ResolvedVault): AgentTool<typeof SearchWebSchema> {
  return {
    name: "search_web",
    label: "Web Search",
    description:
      "Search the web using Exa's semantic search. Returns relevant pages with titles, URLs, and optionally content/summaries. " +
      "Use natural language queries — Exa understands meaning, not just keywords. " +
      "Example: 'how to implement OAuth2 with Better Auth in Next.js'",
    parameters: SearchWebSchema,
    async execute(_id, params, signal) {
      const apiKey = getExaApiKey(vault);
      if (!apiKey) {
        return err("Error: EXA_API_KEY not found. Add it to vault (service: exa, key: key) or set as environment variable.");
      }

      const numResults = Math.min(params.numResults ?? DEFAULT_NUM_RESULTS, 20);
      const includeContent = params.includeContent ?? true;

      const body: Record<string, unknown> = {
        query: params.query,
        numResults,
        type: "auto",
      };

      if (includeContent) {
        body.contents = {
          text: { maxCharacters: 2000 },
          highlights: { numSentences: 3 },
          summary: { query: params.query },
        };
      }

      if (params.includeDomains?.length) body.includeDomains = params.includeDomains;
      if (params.excludeDomains?.length) body.excludeDomains = params.excludeDomains;
      if (params.startPublishedDate) body.startPublishedDate = params.startPublishedDate;
      if (params.category) body.category = params.category;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
        if (signal) signal.addEventListener("abort", () => controller.abort());

        const response = await fetch(`${EXA_BASE}/search`, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          return err(`Error: Exa API returned ${response.status}: ${errText}`);
        }

        const data = (await response.json()) as ExaResponse;
        const formatted = formatResults(data.results, includeContent);
        const header = `Found ${data.results.length} result(s) for: "${params.query}"`;
        return ok(`${header}\n\n${formatted}`);
      } catch (e: any) {
        const message = e.name === "AbortError" ? "Search timed out" : e.message;
        return err(`Error: Web search failed — ${message}`);
      }
    },
  };
}

// ─── Tool: search_find_similar ───

const FindSimilarSchema = Type.Object({
  url: Type.String({ description: "URL of a page to find similar content for" }),
  numResults: Type.Optional(Type.Number({ description: `Number of results (default: ${DEFAULT_NUM_RESULTS}, max: 20)` })),
  includeContent: Type.Optional(Type.Boolean({ description: "Include page content/summary (default: false)" })),
  excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Exclude results from these domains" })),
});

function createFindSimilarTool(vault?: ResolvedVault): AgentTool<typeof FindSimilarSchema> {
  return {
    name: "search_find_similar",
    label: "Find Similar Pages",
    description:
      "Find web pages similar to a given URL. Useful for finding alternatives, competitors, or related resources. " +
      "Example: give it a GitHub repo URL to find similar projects.",
    parameters: FindSimilarSchema,
    async execute(_id, params, signal) {
      const apiKey = getExaApiKey(vault);
      if (!apiKey) {
        return err("Error: EXA_API_KEY not found. Add it to vault or set as environment variable.");
      }

      const numResults = Math.min(params.numResults ?? DEFAULT_NUM_RESULTS, 20);
      const includeContent = params.includeContent ?? false;

      const body: Record<string, unknown> = {
        url: params.url,
        numResults,
      };

      if (includeContent) {
        body.contents = {
          text: { maxCharacters: 2000 },
          highlights: { numSentences: 3 },
        };
      }

      if (params.excludeDomains?.length) body.excludeDomains = params.excludeDomains;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
        if (signal) signal.addEventListener("abort", () => controller.abort());

        const response = await fetch(`${EXA_BASE}/findSimilar`, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          return err(`Error: Exa API returned ${response.status}: ${errText}`);
        }

        const data = (await response.json()) as ExaResponse;
        const formatted = formatResults(data.results, includeContent);
        const header = `Found ${data.results.length} page(s) similar to: ${params.url}`;
        return ok(`${header}\n\n${formatted}`);
      } catch (e: any) {
        const message = e.name === "AbortError" ? "Search timed out" : e.message;
        return err(`Error: Find similar failed — ${message}`);
      }
    },
  };
}

// ─── Factory ───

export type SearchToolName = "search_web" | "search_find_similar";

export const ALL_SEARCH_TOOL_NAMES: readonly SearchToolName[] = ["search_web", "search_find_similar"];

/**
 * Create Exa-powered web search tools.
 *
 * @param vault - Resolved vault credentials (looks for EXA_API_KEY)
 * @param allowedTools - Optional filter
 */
export function createSearchTools(
  vault?: ResolvedVault,
  allowedTools?: string[],
): AgentTool<any>[] {
  const factories: Record<SearchToolName, () => AgentTool<any>> = {
    search_web: () => createSearchWebTool(vault),
    search_find_similar: () => createFindSimilarTool(vault),
  };

  const names = allowedTools
    ? ALL_SEARCH_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : [...ALL_SEARCH_TOOL_NAMES];

  return names.map(n => factories[n]());
}
