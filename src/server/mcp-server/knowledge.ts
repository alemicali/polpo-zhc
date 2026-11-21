/**
 * What the instance knows: memory (shared, and each agent's own), the company brain (entities,
 * relations and claims), and what agents learned from their conversations.
 */
import { z } from "zod";
import {
  BAD_CURSOR, DESTRUCTIVE, READ, WRITE, apiError, apiGet, apiSend, confirmParam, cursorParam, enc, fail, limitParam, looseObject, ok,
  page, pageOutput, short,
  type McpDeps, type Register,
} from "./kit.js";

/** Longest memory accepted (characters). */
const MAX_MEMORY_CHARS = 200_000;

const memoryPath = (agent?: string) => agent ? `/memory/agent/${enc(agent)}` : "/memory";

async function readMemory(deps: McpDeps, agent?: string) {
  const r = await apiGet(deps, memoryPath(agent));
  if (!r.ok) return r;
  const d = r.data as { exists?: boolean; content?: unknown };
  return { ok: true as const, exists: !!d?.exists, content: typeof d?.content === "string" ? d.content : "" };
}

export function registerMemoryTools(tool: Register, deps: McpDeps): void {
  const output = { scope: z.enum(["shared", "agent"]), agent: z.string().optional(), exists: z.boolean(), content: z.string(), chars: z.number().int() };

  tool("memory", "polpo_memory_get", {
    title: "Read memory",
    description: "The shared memory every agent and Polpo read (the project's facts, preferences, decisions), or one agent's own memory (agent).",
    inputSchema: { agent: z.string().optional().describe("An agent's name for its own memory; omit for the shared memory") },
    outputSchema: output,
    annotations: READ,
  }, async ({ agent }) => {
    const r = await readMemory(deps, agent);
    if (!r.ok) return apiError(r, `Reading ${agent ? `${agent}'s` : "the shared"} memory`, r.status === 404 ? "Check the agent's name with polpo_agents_list." : undefined);
    return ok(r.content || `(${agent ? `${agent}'s` : "The shared"} memory is empty.)`,
      { scope: agent ? "agent" : "shared", ...(agent ? { agent } : {}), exists: r.exists, content: r.content, chars: r.content.length });
  });

  tool("memory", "polpo_memory_update", {
    title: "Write memory",
    description: "Change the shared memory or an agent's own memory (agent): append adds a note at the end; replace rewrites it all; clear empties it. "
      + "replace and clear lose what was there: they need confirm: true after the person agreed (read it first with polpo_memory_get).",
    inputSchema: {
      agent: z.string().optional().describe("An agent's name for its own memory; omit for the shared memory"),
      mode: z.enum(["append", "replace", "clear"]).describe("append (add at the end), replace (rewrite it all), clear (empty it)"),
      content: z.string().max(MAX_MEMORY_CHARS).optional().describe("The text to append, or the whole new memory for replace (markdown)"),
      confirm: confirmParam("replace or clear the memory"),
    },
    outputSchema: { ...output, previous_chars: z.number().int() },
    annotations: DESTRUCTIVE,
  }, async ({ agent, mode, content, confirm }) => {
    if (mode !== "clear" && !content?.trim()) return fail(`${mode} needs content.`);
    if (mode === "clear" && content) return fail("clear takes no content (use replace to rewrite it).");
    const before = await readMemory(deps, agent);
    if (!before.ok) return apiError(before, `Reading ${agent ? `${agent}'s` : "the shared"} memory`, before.status === 404 ? "Check the agent's name with polpo_agents_list." : undefined);
    if (mode !== "append" && confirm !== true && before.content.trim()) {
      return fail(`${mode === "clear" ? "Clearing" : "Replacing"} ${agent ? `${agent}'s` : "the shared"} memory loses its ${before.content.length} characters: ask the person, then call again with confirm: true.`);
    }
    const next = mode === "clear" ? "" : mode === "replace" ? content! : `${before.content.replace(/\s+$/, "")}${before.content.trim() ? "\n\n" : ""}${content!.trim()}\n`;
    if (next.length > MAX_MEMORY_CHARS) return fail(`The memory would be ${next.length} characters: the limit is ${MAX_MEMORY_CHARS}. Replace it with a shorter version.`);
    const r = await apiSend(deps, "PUT", memoryPath(agent), { content: next });
    if (!r.ok) return apiError(r, `Writing ${agent ? `${agent}'s` : "the shared"} memory`);
    const verb = mode === "append" ? "Appended to" : mode === "replace" ? "Replaced" : "Cleared";
    return ok(`${verb} ${agent ? `${agent}'s` : "the shared"} memory (${before.content.length} → ${next.length} characters).`,
      { scope: agent ? "agent" : "shared", ...(agent ? { agent } : {}), exists: true, content: next, chars: next.length, previous_chars: before.content.length });
  });
}

const STATUS = ["candidate", "confirmed", "rejected", "archived"] as const;
const evidence = z.object({
  sourceType: z.enum(["data-source", "file", "chat", "task", "mission", "app", "manual"]).describe("Where it comes from"),
  sourceId: z.string().min(1).describe("Its id there (a file path, a task id…)"),
  excerpt: z.string().max(2000).optional().describe("The passage that shows it"),
}).describe("What supports it");

type Entity = { id: string; type: string; name: string; summary?: string; status?: string; aliases?: string[]; score?: number; tags?: string[] };

export function registerBrainTools(tool: Register, deps: McpDeps): void {
  const entityItem = z.object({ id: z.string(), type: z.string(), name: z.string(), summary: z.string().optional(), status: z.string().optional(), score: z.number().optional() }).passthrough();
  const line = (e: Entity) => `- ${e.id} [${e.type}] ${e.name}${e.status && e.status !== "confirmed" ? ` (${e.status})` : ""}${e.summary ? `: ${short(e.summary, 140)}` : ""}`;

  tool("brain", "polpo_brain_search", {
    title: "Search the company brain",
    description: "Find what the company brain knows (people, companies, products, projects… and how they relate) by words; "
      + "without text, the most connected entities and counts. Read one with polpo_brain_get.",
    inputSchema: {
      text: z.string().optional().describe("Words to look for (names, aliases, summaries)"),
      types: z.array(z.string()).optional().describe("Only these entity types, e.g. ['person', 'company']"),
      limit: limitParam(20, 100),
      cursor: cursorParam(),
    },
    outputSchema: { ...pageOutput(entityItem), stats: looseObject.optional() },
    annotations: READ,
  }, async ({ text, types, limit, cursor }) => {
    const n = limit ?? 20;
    let all: Entity[];
    let stats: Record<string, unknown> | undefined;
    if (text?.trim()) {
      const r = await apiGet(deps, `/brain/search?q=${enc(text.trim())}&limit=200`);
      if (!r.ok) return apiError(r, "Searching the brain");
      all = ((r.data as Entity[]) ?? []).filter((e) => !types?.length || types.includes(e.type));
    } else {
      const r = await apiGet(deps, `/brain/graph?limit=500${types?.length ? `&types=${enc(types.join(","))}` : ""}`);
      if (!r.ok) return apiError(r, "Reading the brain");
      const g = r.data as { entities?: Entity[]; stats?: Record<string, unknown> };
      all = g.entities ?? [];
      stats = g.stats;
    }
    const p = page(all.map((e) => ({ id: e.id, type: e.type, name: e.name, ...(e.summary ? { summary: e.summary } : {}), ...(e.status ? { status: e.status } : {}), ...(e.score !== undefined ? { score: e.score } : {}) })), n, cursor);
    if (!p) return fail(BAD_CURSOR);
    return ok(`${p.items.map(line).join("\n") || "Nothing found."}${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}${stats ? `\n${JSON.stringify(stats)}` : ""}`, { ...p, ...(stats ? { stats } : {}) });
  });

  tool("brain", "polpo_brain_get", {
    title: "Read a brain entity",
    description: "One entity of the company brain with its relations (to and from other entities) and its claims (facts with evidence).",
    inputSchema: { id: z.string().min(1).describe("The entity's id (polpo_brain_search)") },
    outputSchema: { entity: looseObject, relations: z.array(looseObject), claims: z.array(looseObject) },
    annotations: READ,
  }, async ({ id }) => {
    const r = await apiGet(deps, `/brain/entities/${enc(id)}`);
    if (!r.ok) return r.status === 404 ? fail(`There is no brain entity ${id}. Find it with polpo_brain_search.`) : apiError(r, `Reading brain entity ${id}`);
    const d = r.data as { entity: Entity & Record<string, unknown>; relations: Array<Record<string, unknown>>; claims: Array<Record<string, unknown>> };
    const e = d.entity;
    return ok([
      `${e.id} [${e.type}] ${e.name}${e.aliases?.length ? ` (aka ${e.aliases.join(", ")})` : ""}${e.status ? ` · ${e.status}` : ""}`,
      ...(e.summary ? [e.summary] : []),
      ...(d.relations.length ? ["relations:", ...d.relations.map((x) => `- ${String(x.fromId)} —${String(x.type)}→ ${String(x.toId)}${x.label ? ` (${String(x.label)})` : ""} [${String(x.id)}]`)] : []),
      ...(d.claims.length ? ["claims:", ...d.claims.map((x) => `- ${String(x.predicate)}: ${short(JSON.stringify(x.value), 200)} [${String(x.id)}]`)] : []),
    ].join("\n"), d);
  });

  tool("brain", "polpo_brain_save", {
    title: "Save to the company brain",
    description: "Add or change what the company brain knows: an entity (type and name; with id to change one), a relation between two entities, "
      + "or a claim (a fact about an entity). Give exactly one of entity, relation, claim.",
    inputSchema: {
      entity: z.object({
        id: z.string().optional().describe("Its id, to change an existing entity"),
        type: z.string().min(1).describe("e.g. person, company, product, project"), name: z.string().min(1),
        aliases: z.array(z.string()).optional(), summary: z.string().optional(), tags: z.array(z.string()).optional(),
        properties: z.record(z.string(), z.unknown()).optional(), status: z.enum(STATUS).optional(), evidence: z.array(evidence).optional(),
      }).optional().describe("An entity"),
      relation: z.object({
        id: z.string().optional().describe("Its id, to change an existing relation"),
        fromId: z.string().min(1), toId: z.string().min(1), type: z.string().min(1).describe("e.g. works_at, owns, depends_on"),
        label: z.string().optional(), status: z.enum(STATUS).optional(), evidence: z.array(evidence).optional(),
      }).optional().describe("A relation between two entities"),
      claim: z.object({
        entityId: z.string().min(1), predicate: z.string().min(1).describe("e.g. revenue, headcount, role"), value: z.unknown().describe("The value"),
        status: z.enum(STATUS).optional(), validFrom: z.string().optional(), validTo: z.string().optional(), evidence: z.array(evidence).optional(),
      }).optional().describe("A fact about an entity"),
    },
    outputSchema: { kind: z.enum(["entity", "relation", "claim"]), saved: looseObject },
    annotations: WRITE,
  }, async ({ entity, relation, claim }) => {
    const given = [entity && "entity", relation && "relation", claim && "claim"].filter(Boolean) as Array<"entity" | "relation" | "claim">;
    if (given.length !== 1) return fail("Give exactly one of entity, relation or claim.");
    const kind = given[0]!;
    const body = (entity ?? relation ?? claim) as { id?: string };
    const path = kind === "entity" ? "/brain/entities" : kind === "relation" ? "/brain/relations" : "/brain/claims";
    const r = body.id && kind !== "claim" ? await apiSend(deps, "PUT", `${path}/${enc(body.id)}`, body) : await apiSend(deps, "POST", path, body);
    if (!r.ok) return apiError(r, `Saving the ${kind}`);
    const saved = r.data as Record<string, unknown>;
    return ok(`Saved ${kind} ${String(saved?.id ?? "")}${kind === "entity" ? ` (${String(saved?.name ?? "")})` : ""}.`, { kind, saved });
  });

  tool("brain", "polpo_brain_delete", {
    title: "Delete from the company brain",
    description: "Delete an entity (with its relations and claims), a relation or a claim. It cannot be undone. Needs confirm: true.",
    inputSchema: {
      kind: z.enum(["entity", "relation", "claim"]).describe("What to delete"),
      id: z.string().min(1).describe("Its id"),
      confirm: confirmParam("delete it"),
    },
    outputSchema: { kind: z.string(), id: z.string(), deleted: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ kind, id, confirm }) => {
    if (confirm !== true) return fail(`Deleting ${kind} ${id} from the company brain cannot be undone: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/brain/${kind === "entity" ? "entities" : kind === "relation" ? "relations" : "claims"}/${enc(id)}`);
    if (!r.ok) return r.status === 404 ? fail(`There is no ${kind} ${id}. Find it with polpo_brain_search / polpo_brain_get.`) : apiError(r, `Deleting ${kind} ${id}`);
    return ok(`Deleted ${kind} ${id}.`, { kind, id, deleted: true });
  });
}

type Change = { id: string; at?: string; createdAt?: string; kind?: string; type?: string; summary?: string; reverted?: boolean; revertedAt?: string };

export function registerLearningTools(tool: Register, deps: McpDeps): void {
  const changeItem = looseObject;
  const line = (c: Change) => `- ${c.id} ${(c.at ?? c.createdAt ?? "").slice(0, 16).replace("T", " ")} ${c.kind ?? c.type ?? "change"}: ${short(c.summary ?? "", 160)}${c.reverted || c.revertedAt ? " (reverted)" : ""}`;

  tool("learning", "polpo_learning_get", {
    title: "What an agent learned",
    description: "An agent's learning settings and the changes it made to itself from its conversations (memory, skills, instructions), newest first. "
      + "Undo one with polpo_learning_revert.",
    inputSchema: { agent: z.string().min(1).describe("The agent's name"), limit: limitParam(20, 200) },
    outputSchema: { learning: looseObject, changes: z.array(changeItem) },
    annotations: READ,
  }, async ({ agent, limit }) => {
    const r = await apiGet(deps, `/learning/${enc(agent)}?limit=${limit ?? 20}`);
    if (!r.ok) return r.status === 404 ? fail(`There is no agent "${agent}". Find the name with polpo_agents_list.`) : apiError(r, `Reading ${agent}'s learning`);
    const d = r.data as { learning: Record<string, unknown>; changes: Change[] };
    return ok(`learning: ${JSON.stringify(d.learning)}\n${d.changes.map(line).join("\n") || "No changes yet."}`, { learning: d.learning, changes: d.changes as Array<Record<string, unknown>> });
  });

  tool("learning", "polpo_learning_review", {
    title: "Have an agent learn now",
    description: "Have an agent review its recent conversations now and learn from them (it may update its memory or skills); returns the changes it made.",
    inputSchema: { agent: z.string().min(1).describe("The agent's name") },
    outputSchema: { changes: z.array(changeItem) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ agent }) => {
    const r = await apiSend(deps, "POST", `/learning/${enc(agent)}/review`);
    if (!r.ok) return r.status === 404 ? fail(`There is no agent "${agent}". Find the name with polpo_agents_list.`) : apiError(r, `Reviewing ${agent}'s conversations`);
    const changes = ((r.data as { changes?: Change[] })?.changes ?? []);
    return ok(changes.length ? `${agent} made ${changes.length} change(s):\n${changes.map(line).join("\n")}` : `${agent} found nothing to learn.`, { changes: changes as Array<Record<string, unknown>> });
  });

  tool("learning", "polpo_learning_revert", {
    title: "Undo what an agent learned",
    description: "Put back what was there before one of an agent's learning changes (polpo_learning_get lists them). Needs confirm: true.",
    inputSchema: { agent: z.string().min(1).describe("The agent's name"), change_id: z.string().min(1).describe("The change's id"), confirm: confirmParam("revert the change") },
    outputSchema: { change: looseObject },
    annotations: DESTRUCTIVE,
  }, async ({ agent, change_id, confirm }) => {
    if (confirm !== true) return fail(`Reverting change ${change_id} of ${agent} puts back what was there before: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "POST", `/learning/${enc(agent)}/changes/${enc(change_id)}/revert`);
    if (!r.ok) return apiError(r, `Reverting change ${change_id}`, r.status === 409 ? "It may be reverted already, or changed again since: read polpo_learning_get." : undefined);
    return ok(`Reverted change ${change_id} of ${agent}.`, { change: (r.data as { change?: Record<string, unknown> })?.change ?? {} });
  });
}
