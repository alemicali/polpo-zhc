/**
 * Compaction for a chat session: the shared ContextCompactor, restored from and saved to the
 * session's durable checkpoint, with model summaries, durable facts and the context:compacted
 * event. Used by every conversational path (web chat completions, Polpo on messaging channels).
 */
import {
  buildSummaryPrompt,
  ContextCompactor,
  contextBudgetForModel,
  estimateContextTokens,
  parseSummary,
  type CompactionInfo,
  type CompactionSettings,
} from "@polpo-ai/core";
import { redactSecrets } from "@polpo-ai/core/secret-redaction";
import { loadContextCheckpoint, saveContextCheckpoint, type ContextCheckpointStore } from "./context-checkpoint.js";

export interface SessionCompactorOptions {
  /** The conversation's model (window, provider). */
  model: any;
  settings: CompactionSettings;
  systemPrompt: () => string;
  tools: () => unknown[];
  /** Caller-visible history at the start of the turn: the durable checkpoint covers a prefix of it. */
  original: any[];
  sessionId: string | null;
  /** Identifies what the checkpoint is valid for (session creation, agent, model…). */
  scope: string;
  store?: ContextCheckpointStore;
  /** One-shot completion; without it the deterministic extract is used. */
  completeLLM?: (model: any, context: { systemPrompt: string; messages: any[] }, options?: any) => Promise<any>;
  /** Model that writes a summary of `promptTokens` tokens (default: the conversation's model). */
  summaryModel?: (promptTokens: number) => any;
  /** Where durable facts go (agent scope for agent chats, shared for Polpo). */
  memory?: { store: { get(scope?: string): Promise<string>; append(line: string, scope?: string): Promise<void> }; scope?: string };
  /** Emits context:compacted (the caller adds who/where). */
  onCompacted?: (info: CompactionInfo & { savedFacts?: number }) => void;
}

export interface SessionCompaction {
  prepare(full: any[], force?: "overflow" | "manual", focus?: string): Promise<{ messages: any[]; info: CompactionInfo | null }>;
  /** Provider usage of the last call (input + cache read + cache write). */
  noteUsage(inputTokens: number): void;
}

export async function createSessionCompaction(opts: SessionCompactorOptions): Promise<SessionCompaction> {
  const checkpoint = await loadContextCheckpoint(opts.store, opts.sessionId, opts.scope, opts.original).catch(() => null);
  let revision = checkpoint?.revision ?? null;
  let savedFacts = 0;
  let lastProjectedCount = 0;

  const compactor = new ContextCompactor({
    budget: contextBudgetForModel(opts.model ?? {}, opts.settings),
    settings: opts.settings,
    pinned: () => 0,
    baseTokens: () => estimateContextTokens({ systemPrompt: opts.systemPrompt(), messages: [], tools: opts.tools() }),
    summarize: opts.completeLLM ? async ({ messages, previousSummary, focus, signal }) => {
      const { systemPrompt, prompt } = buildSummaryPrompt({ messages, previousSummary, focus });
      const model = opts.summaryModel?.(Math.ceil((systemPrompt.length + prompt.length) / 3)) ?? opts.model;
      const response = await opts.completeLLM!(model, {
        systemPrompt,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
      }, { signal, maxTokens: 8_000 });
      if (response?.stopReason === "error") throw new Error(response.errorMessage ?? "summary failed");
      const text = (response?.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
      const parsed = parseSummary(text);
      return { summary: parsed.summary, durableFacts: parsed.durableFacts, model: `${model?.provider}:${model?.id}` };
    } : undefined,
    onDurableFacts: async (facts) => {
      const memory = opts.memory;
      if (!memory) return;
      // incremental summaries repeat earlier facts: only new ones, a few per compaction
      const known = String((await memory.store.get(memory.scope).catch(() => "")) ?? "").toLowerCase();
      for (const fact of facts.slice(0, 10)) {
        const line = redactSecrets(fact.length > 300 ? `${fact.slice(0, 297)}...` : fact);
        if (known.includes(line.toLowerCase())) continue;
        try { await memory.store.append(line, memory.scope); savedFacts += 1; } catch { /* memory is best effort */ }
      }
    },
  });
  if (checkpoint) compactor.restoreState({ covered: checkpoint.covered, summary: checkpoint.summary, pruned: [], count: checkpoint.count });

  return {
    async prepare(full, force, focus) {
      savedFacts = 0;
      const { messages, info } = await compactor.prepare(full, { force, focus });
      lastProjectedCount = messages.length;
      if (!info) return { messages, info: null };
      // Persist the summary for the caller-visible history it covers (redacted). A storage
      // failure must not fail the conversation.
      const state = compactor.getState();
      if (state.summary && state.covered > 0) {
        await saveContextCheckpoint(opts.store, opts.sessionId, opts.scope, opts.original,
          Math.min(state.covered, opts.original.length), redactSecrets(state.summary), state.count, revision)
          .then((next) => { if (next) revision = next; })
          .catch((error) => console.warn("[context-checkpoint] save failed:", error instanceof Error ? error.name : "unknown"));
      }
      opts.onCompacted?.({ ...info, ...(savedFacts ? { savedFacts } : {}) });
      return { messages, info };
    },
    noteUsage(inputTokens) {
      compactor.noteUsage(inputTokens, lastProjectedCount);
    },
  };
}
