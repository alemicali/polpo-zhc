import { summarizeContextMessages } from "@polpo-ai/core";
import type { ContextCheckpoint, ContextCheckpointStore } from "@polpo-ai/core/context-checkpoint";

export type { ContextCheckpoint, ContextCheckpointStore } from "@polpo-ai/core/context-checkpoint";

const checkpointMessage = (summary: string) => ({
  role: "user",
  content: `[Context checkpoint: earlier conversation compacted]\n\n${summary}\n\n[End context checkpoint]`,
  timestamp: Date.now(),
});

// Only semantic input participates: conversion timestamps change on every request.
async function fingerprint(message: any): Promise<string> {
  const content = Array.isArray(message.content) && message.content.every((part: any) => part.type === "text")
    ? message.content.map((part: any) => part.text).join("\n") : message.content;
  const bytes = new TextEncoder().encode(JSON.stringify([message.role, content]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
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

/** The session's checkpoint, when its covered prefix is still the start of this conversation. */
export async function loadContextCheckpoint(
  store: ContextCheckpointStore | undefined, sessionId: string | null, scope: string, original: any[],
): Promise<LoadedContextCheckpoint | null> {
  if (!store || !sessionId) return null;
  const saved = await store.load(sessionId).catch(() => null);
  if (!saved || saved.scope !== scope || saved.prefixHashes.length > original.length) return null;
  const current = await Promise.all(saved.prefixHashes.map((_, i) => fingerprint(original[i])));
  if (!current.every((hash, i) => hash === saved.prefixHashes[i])) return null;
  return { covered: current.length, summary: saved.summary, count: saved.count ?? 1, revision: saved.revision };
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
  const next: ContextCheckpoint = {
    version: 1, revision: crypto.randomUUID(), scope,
    prefixHashes: await Promise.all(original.slice(0, covered).map((message) => fingerprint(message))),
    summary: summary.length > 60_000 ? `${summary.slice(0, 59_900)}\n[summary truncated]` : summary,
    count,
  };
  return (await store.save(sessionId, next, previousRevision)) ? next.revision : null;
}
