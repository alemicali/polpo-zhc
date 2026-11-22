/**
 * Regression: a long chat compacted at (almost) every turn.
 *
 * Seen on a live instance: a 1,900-message agent chat used from Telegram and the web logged
 * "checkpoint not reused, message N of the ~1,550 it covers is in another position" on 15 of its
 * last 23 turns, and each of those turns summarized the whole conversation again. The checkpoint
 * was compared message by message, by position, against a history that each path rebuilds a
 * little differently (the web keeps empty and tool-only answers and adds `[file: …]` references,
 * the channels drop empty messages, the store returned messages saved in the same millisecond in
 * any order). Numbers here are the live ones: a 272k window (gpt-6-astra) and Polpo's real tools.
 */
import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionCompaction, inspectContextCheckpoint, checkpointText } from "@polpo-ai/server";
import { ProgressiveToolSet, POLPO_TOOL_GROUPS } from "@polpo-ai/core";
import { ALL_ORCHESTRATOR_TOOLS } from "../llm/orchestrator-tools.js";
import { FileContextCheckpointStore } from "../stores/file-context-checkpoint-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

interface Stored { role: "user" | "assistant"; content: string; attachments?: string[] }

/** A long coaching chat: some answers were tool-only (empty text), some questions had photos. */
function storedConversation(turns: number): Stored[] {
  const out: Stored[] = [];
  for (let i = 0; i < turns; i += 1) {
    out.push({ role: "user", content: `Domanda ${i}: cosa mangio stasera?`, ...(i % 25 === 0 ? { attachments: [`workspace/attachments/s/${i}.jpg`] } : {}) });
    out.push({ role: "assistant", content: i % 30 === 7 ? "" : `# Risposta ${i}\n\n${"Proteine, carboidrati e grassi del pasto, con le quantità. ".repeat(20)}` });
  }
  return out;
}

/** What the completions route makes of the messages a caller sends (convertMessages). */
const toModel = (messages: Array<{ role: string; content: string }>) => messages.map((m) => m.role === "assistant"
  ? { role: "user", content: `[Previous assistant response]\n${m.content}\n[End previous response]`, timestamp: Date.now() }
  : { role: "user", content: m.content, timestamp: Date.now() });

/** The web UI: every message with text, tool calls or files, `[file: …]` references added. */
const fromWeb = (stored: Stored[]) => toModel(stored.map((m) => ({
  role: m.role, content: [m.content, ...(m.attachments ?? []).map((path) => `[file: ${path}]`)].filter(Boolean).join("\n\n"),
})));
/** Telegram / WhatsApp (channel runner): messages with text only, no file references. */
const fromChannel = (stored: Stored[]) => toModel(stored.filter((m) => m.content).map((m) => ({ role: m.role, content: m.content })));

test("a long chat answered alternately from the web and a channel compacts once, not at every turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polpo-compaction-")); directories.push(dir);
  const store = new FileContextCheckpointStore(dir);
  const model = { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 272_000, maxTokens: 128_000 };
  const tools = new ProgressiveToolSet({ tools: ALL_ORCHESTRATOR_TOOLS as any[], mode: "auto", groups: POLPO_TOOL_GROUPS }).initialTools({ plainMeta: true });
  const systemPrompt = "You are the health coach. ".repeat(2_000); // ~50k characters, like a real agent prompt
  const scope = JSON.stringify(["2026-05-06T21:39:07.001Z", "health-coach", model.provider, model.id]);
  const turn = (original: any[]) => createSessionCompaction({
    model, settings: {}, systemPrompt: () => systemPrompt, tools: () => tools,
    original, sessionId: "A4mfZRKH7y", scope, store,
  });

  const stored = storedConversation(950);
  const compactions: Array<string | null> = [];
  for (let i = 0; i < 6; i += 1) {
    stored.push({ role: "user", content: `Nuova domanda ${i}`, ...(i === 2 ? { attachments: ["workspace/attachments/s/new.jpg"] } : {}) });
    const original = i % 2 === 0 ? fromChannel(stored) : fromWeb(stored);
    const inspection = await inspectContextCheckpoint(store, "A4mfZRKH7y", scope, original);
    if (i > 0) expect(inspection.rejected).toBeUndefined();
    const { info, messages } = await (await turn(original)).prepare([...original]);
    compactions.push(info ? info.mode : null);
    if (i > 0) expect(String(messages[0].content)).toContain("Context checkpoint");
    stored.push({ role: "assistant", content: i === 3 ? "" : `Risposta nuova ${i}` });
  }
  // the first turn compacts the long history; the next five reuse its checkpoint
  expect(compactions[0]).not.toBeNull();
  expect(compactions.slice(1)).toEqual([null, null, null, null, null]);
});

test("checkpoint text: the same message from every path, empty ones skipped", () => {
  expect(checkpointText({ role: "user", content: "[Previous assistant response]\n\n[End previous response]" })).toBeNull();
  expect(checkpointText({ role: "user", content: "" })).toBeNull();
  const web = checkpointText({ role: "user", content: "che ne pensi?\n\n[file: /data/lumea/workspace/attachments/s/a.jpg]" });
  const channel = checkpointText({ role: "user", content: [{ type: "text", text: "che ne pensi?" }, { type: "image", data: "AAAA", mimeType: "image/jpeg" }] });
  expect(web).toEqual(channel);
  expect(checkpointText({ role: "user", content: "[Previous assistant response]\nok\n[End previous response]" }))
    .toEqual({ assistant: true, text: "ok" });
  expect(checkpointText({ role: "user", content: "ok" })).toEqual({ assistant: false, text: "ok" });
});
