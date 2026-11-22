import { summarizeContextMessages } from "@polpo-ai/core";
import type { ContextCheckpoint, ContextCheckpointStore } from "@polpo-ai/core/context-checkpoint";

export type { ContextCheckpoint, ContextCheckpointStore } from "@polpo-ai/core/context-checkpoint";

const checkpointMessage = (summary: string) => ({
  role: "user",
  content: `[Context checkpoint: earlier conversation compacted]\n\n${summary}\n\n[End context checkpoint]`,
  timestamp: Date.now(),
});

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}

// Only semantic input participates: conversion timestamps change on every request.
// Position-based (version 1): kept for contextCheckpointProjection.
async function fingerprint(message: any): Promise<string> {
  const content = Array.isArray(message.content) && message.content.every((part: any) => part.type === "text")
    ? message.content.map((part: any) => part.text).join("\n") : message.content;
  return sha256([message.role, content]);
}

const ASSISTANT_OPEN = "[Previous assistant response]";
const ASSISTANT_CLOSE = "[End previous response]";

/**
 * What a message says, the same whichever path rebuilt the history: the web UI, a messaging
 * channel, the turn scheduler and the background runners each send a session's history a little
 * differently (empty or tool-only answers kept or dropped, `[file: …]` references added or not,
 * images inline or not). Only the text counts, without file references and extra whitespace;
 * `null` for a message with no text, which the checkpoint skips.
 */
export function checkpointText(message: any): { assistant: boolean; text: string } | null {
  const content = message?.content;
  let text = typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n")
      : "";
  let assistant = message?.role === "assistant";
  text = text.trim();
  if (text.startsWith(ASSISTANT_OPEN) && text.endsWith(ASSISTANT_CLOSE)) {
    assistant = true;
    text = text.slice(ASSISTANT_OPEN.length, text.length - ASSISTANT_CLOSE.length);
  }
  text = text.replace(/\[file: [^\]\n]*\]/g, " ").replace(/\s+/g, " ").trim();
  return text ? { assistant, text } : null;
}

/** Hashes of the messages with text (version 2), each with its index in `messages`. */
async function textHashes(messages: any[]): Promise<Array<{ index: number; hash: string }>> {
  const out: Array<{ index: number; hash: string }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const canonical = checkpointText(messages[index]);
    if (canonical) out.push({ index, hash: await sha256([canonical.assistant ? "assistant" : "user", canonical.text]) });
  }
  return out;
}

/** Reuse a verified prefix; never replace the user-visible session transcript. */
export async function contextCheckpointProjection(
  store: ContextCheckpointStore | undefined, sessionId: string | null,
  scope: string, original: any[],
) {
  let saved = store && sessionId ? await store.load(sessionId).catch(() => null) : null;
  let covered = 0;
  let marker: ReturnType<typeof checkpointMessage> | undefined;
  let safeSummary: string | undefined;
  const hashes = new Map<number, Promise<string>>();
  const hashAt = (i: number) => {
    if (!hashes.has(i)) hashes.set(i, fingerprint(original[i]));
    return hashes.get(i)!;
  };
  if (saved?.scope === scope && saved.prefixHashes.length <= original.length) {
    const current = await Promise.all(saved.prefixHashes.map((_, i) => hashAt(i)));
    if (current.every((hash, i) => hash === saved!.prefixHashes[i])) {
      covered = current.length;
      marker = checkpointMessage(saved.summary);
      safeSummary = saved.summary;
    }
  }
  const indices = new Map(original.map((message, i) => [message, i]));
  return {
    messages: marker ? [marker, ...original.slice(covered)] : original,
    async remember(prefix: any[], nextMarker: any): Promise<void> {
      if (!store || !sessionId) return;
      const eligible = prefix.filter(message => message === marker || indices.has(message));
      const nextCovered = eligible.reduce((count, message) => Math.max(count, (indices.get(message) ?? -1) + 1), covered);
      if (nextCovered <= covered) { marker = nextMarker; return; }
      // Do not persist native tool calls/results from the in-flight loop (they
      // may contain vault values). Only caller history and the earlier safe
      // checkpoint are covered by this durable projection.
      const textOnly = eligible.map(message => message === marker && safeSummary
        ? checkpointMessage(safeSummary) : ({ ...message,
        content: Array.isArray(message.content) ? message.content.map((part: any) =>
          part.type === "image" ? { type: "text", text: "[Earlier image: consult the original attachment]" } : part) : message.content,
      }));
      const next: ContextCheckpoint = {
        version: 1, revision: crypto.randomUUID(), scope,
        prefixHashes: await Promise.all(original.slice(0, nextCovered).map((_, i) => hashAt(i))),
        summary: summarizeContextMessages(textOnly),
      };
      try {
        if (await store.save(sessionId, next, saved?.revision ?? null)) saved = next;
      } finally {
        covered = nextCovered;
        marker = nextMarker;
        safeSummary = next.summary;
      }
    },
  };
}


/** A stored checkpoint, verified against the conversation it is applied to. */
export interface LoadedContextCheckpoint {
  /** Leading messages of `original` the summary covers. */
  covered: number;
  summary: string;
  count: number;
  revision: string;
}

/** The session's stored checkpoint, checked against this conversation. */
export interface ContextCheckpointInspection {
  /** Usable: its covered prefix is still the start of this conversation. */
  checkpoint: LoadedContextCheckpoint | null;
  /** The revision in storage, usable or not: a new checkpoint replaces it (compare-and-swap). */
  storedRevision: string | null;
  /** Why a stored checkpoint is not usable. */
  rejected?: string;
}

export async function inspectContextCheckpoint(
  store: ContextCheckpointStore | undefined, sessionId: string | null, scope: string, original: any[],
): Promise<ContextCheckpointInspection> {
  if (!store || !sessionId) return { checkpoint: null, storedRevision: null };
  const saved = await store.load(sessionId).catch(() => null);
  if (!saved) return { checkpoint: null, storedRevision: null };
  const stale = (rejected: string) => ({ checkpoint: null, storedRevision: saved.revision, rejected });
  if (saved.scope !== scope) return stale("made for another model or session");
  if (saved.version !== 2) return stale("made by an older version");
  const current = await textHashes(original);
  const covers = saved.prefixHashes.length;
  if (covers > current.length) return stale(`it covers ${covers} messages, the conversation has ${current.length}`);
  const at = saved.prefixHashes.findIndex((hash, i) => hash !== current[i]!.hash);
  if (at >= 0) {
    const moved = current.some((entry) => entry.hash === saved.prefixHashes[at]);
    return stale(`message ${at + 1} of the ${covers} it covers ${moved ? "is in another position" : "changed"} (${String(original[current[at]!.index]?.role)})`);
  }
  // covered: up to the last message it summarizes, in this conversation's own indexing
  const covered = current[covers - 1]!.index + 1;
  return { checkpoint: { covered, summary: saved.summary, count: saved.count ?? 1, revision: saved.revision }, storedRevision: saved.revision };
}

/** The session's checkpoint, when its covered prefix is still the start of this conversation. */
export async function loadContextCheckpoint(
  store: ContextCheckpointStore | undefined, sessionId: string | null, scope: string, original: any[],
): Promise<LoadedContextCheckpoint | null> {
  return (await inspectContextCheckpoint(store, sessionId, scope, original)).checkpoint;
}

/**
 * Store the checkpoint for the first `covered` messages of `original` (the caller-visible
 * history). Compare-and-swap on the previous revision; returns the new revision when saved.
 */
export async function saveContextCheckpoint(
  store: ContextCheckpointStore | undefined, sessionId: string | null, scope: string, original: any[],
  covered: number, summary: string, count: number, previousRevision: string | null,
): Promise<string | null> {
  if (!store || !sessionId || covered <= 0) return null;
  const prefixHashes = (await textHashes(original.slice(0, covered))).map((entry) => entry.hash);
  // nothing with text in the covered part: nothing to verify it against later
  if (prefixHashes.length === 0) return null;
  const next: ContextCheckpoint = {
    version: 2, revision: crypto.randomUUID(), scope,
    prefixHashes,
    summary: summary.length > 60_000 ? `${summary.slice(0, 59_900)}\n[summary truncated]` : summary,
    count,
  };
  return (await store.save(sessionId, next, previousRevision)) ? next.revision : null;
}

/** UI acknowledgement of a client-side tool: stored as a system message, sent to the model as a user turn. */
const CLIENT_TOOL_ACK_PREFIX = "Client-side tool ";

/** A stored message as the turns of a session send it to the model (other system notes aside). */
function storedForModel(message: { role?: string; content?: unknown }): { role: string; content: unknown } | null {
  if (message.role === "user" || message.role === "assistant") return { role: message.role, content: message.content };
  if (message.role === "system" && typeof message.content === "string" && message.content.startsWith(CLIENT_TOOL_ACK_PREFIX)) {
    return { role: "user", content: message.content };
  }
  return null;
}

/** The session fields a checkpoint's scope is made of (see the completions route). */
export interface CheckpointSession { id: string; createdAt: string; agent?: string | null }

export type CarryContextCheckpointResult =
  | { carried: true; covers: number; count: number }
  | { carried: false; reason: string };

/**
 * A branch starts with its parent's checkpoint when the messages the summary covers are all in
 * the copied part of the conversation (at or before the branch point): its first long turn reuses
 * the summary instead of compacting the whole history again. The copy is scoped to the branch
 * (its own creation time) and keeps the parent's agent and model, so a turn with another model
 * ignores it, as it would on the parent. Not copied when it reaches past the branch point (the
 * summary would tell the model what happened after it), when it was made by an older version or
 * for another session or agent, or when it covers the question the branch answers again.
 * `copied`: the branch's messages in order (the copies, or the parent's messages up to the cut).
 */
export async function carryContextCheckpoint(
  store: ContextCheckpointStore | undefined,
  parent: CheckpointSession, fork: CheckpointSession,
  copied: Array<{ role?: string; content?: unknown }>,
): Promise<CarryContextCheckpointResult> {
  if (!store) return { carried: false, reason: "no checkpoint store" };
  const saved = await store.load(parent.id).catch(() => null);
  if (!saved) return { carried: false, reason: "the parent has no checkpoint" };
  if (saved.version !== 2) return { carried: false, reason: "made by an older version" };
  let scope: unknown;
  try { scope = JSON.parse(saved.scope); } catch { scope = null; }
  if (!Array.isArray(scope) || scope.length < 2 || scope[0] !== parent.createdAt) {
    return { carried: false, reason: "made for another session" };
  }
  // the scope keeps the agent and model it was made for: the branch's turns check them as the parent's did
  if ((parent.agent ?? null) !== (fork.agent ?? null)) return { carried: false, reason: "the branch has another agent" };
  const history = copied.map(storedForModel).filter((m): m is { role: string; content: unknown } => m !== null);
  const current = await textHashes(history);
  const covers = saved.prefixHashes.length;
  if (covers > current.length) return { carried: false, reason: "it covers messages after the branch point" };
  if (saved.prefixHashes.some((hash, i) => hash !== current[i]!.hash)) {
    return { carried: false, reason: "it does not match the copied messages" };
  }
  // A branch from a question answers it again: the question itself must reach the model.
  if (history[history.length - 1]?.role === "user" && current[covers - 1]!.index === history.length - 1) {
    return { carried: false, reason: "it covers the message the branch answers again" };
  }
  const next: ContextCheckpoint = {
    ...saved,
    revision: crypto.randomUUID(),
    scope: JSON.stringify([fork.createdAt, ...scope.slice(1)]),
  };
  const stored = await store.save(fork.id, next, null).catch(() => false);
  return stored ? { carried: true, covers, count: saved.count ?? 1 } : { carried: false, reason: "the branch already has a checkpoint" };
}
