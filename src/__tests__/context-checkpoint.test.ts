import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextCheckpointProjection } from "@polpo-ai/server";
import { FileContextCheckpointStore } from "../stores/file-context-checkpoint-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "polpo-checkpoint-")); directories.push(dir);
  return { dir, store: new FileContextCheckpointStore(dir) };
}
const message = (content: string) => ({ role: "user", content, timestamp: Date.now() });

test("checkpoint survives store recreation; new timestamps do not invalidate it", async () => {
  const { dir, store } = await setup(); const history = [message("old decision"), message("recent")];
  const first = await contextCheckpointProjection(store, "chat", "model", history);
  await first.remember(history.slice(0, 1), message("compacted"));
  const checkpoint = await store.load("chat");
  expect(checkpoint?.prefixHashes).toHaveLength(1);
  expect((await stat(join(dir, "context-checkpoints/chat.json"))).mode & 0o777).toBe(0o600);
  const second = await contextCheckpointProjection(new FileContextCheckpointStore(dir), "chat", "model",
    [...history.map(m => ({ ...m, timestamp: 42 })), message("new question")]);
  expect(second.messages[0].content).toContain("Context checkpoint");
  expect(second.messages[0].content).toContain("old decision");
  expect(second.messages.slice(1).map(m => m.content)).toEqual(["recent", "new question"]);
});
test("edited covered history, shorter history, other model or other session cannot reuse a stale checkpoint", async () => {
  const { store } = await setup(); const history = [message("original"), message("second"), message("recent")];
  const first = await contextCheckpointProjection(store, "chat", "model", history);
  await first.remember(history.slice(0, 2), message("marker"));
  for (const [id, scope, input] of [
    ["chat", "model", [message("edited"), ...history.slice(1)]],
    ["chat", "model", history.slice(-1)],
    ["chat", "different-model", history], ["other-chat", "model", history],
  ] as const) {
    expect((await contextCheckpointProjection(store, id, scope, [...input])).messages[0].content).not.toContain("Context checkpoint");
  }
});
test("a delayed older turn cannot overwrite a newer checkpoint", async () => {
  const { store } = await setup(); const history = [message("one"), message("two"), message("three")];
  const stale = await contextCheckpointProjection(store, "chat", "model", history);
  const current = await contextCheckpointProjection(store, "chat", "model", history);
  await current.remember(history.slice(0, 2), message("marker"));
  await stale.remember(history.slice(0, 1), message("marker"));
  expect((await store.load("chat"))?.prefixHashes).toHaveLength(2);
});
test("repeated in-turn compaction preserves previous coverage without persisting private tool results", async () => {
  const { store } = await setup(); const history = [message("decision A"), message("decision B"), message("latest")];
  const projection = await contextCheckpointProjection(store, "chat", "model", history);
  const firstMarker = message("in-turn summary might include private tools");
  await projection.remember(history.slice(0, 1), firstMarker);
  await projection.remember([firstMarker, history[1], { role: "toolResult", content: "PRIVATE_VAULT_RESULT" }], message("next marker"));
  const saved = await store.load("chat");
  expect(saved?.prefixHashes).toHaveLength(2);
  expect(saved?.summary).toContain("decision A"); expect(saved?.summary).toContain("decision B");
  expect(saved?.summary).not.toContain("PRIVATE_VAULT_RESULT");
  expect(saved?.summary).not.toContain("private tools");
});
test("corrupt sidecars safely fall back to original history", async () => {
  const { dir, store } = await setup(); const history = [message("old"), message("new")];
  const first = await contextCheckpointProjection(store, "chat", "model", history);
  await first.remember(history.slice(0, 1), message("marker"));
  await writeFile(join(dir, "context-checkpoints/chat.json"), "{broken");
  expect((await contextCheckpointProjection(store, "chat", "model", history)).messages).toEqual(history);
});

test("web plain text and mobile text-part history reuse the same prefix", async () => {
  const { store } = await setup(); const history = [message("keep decision"), message("new")];
  const first = await contextCheckpointProjection(store, "chat", "model", history);
  await first.remember(history.slice(0, 1), message("marker"));
  const mobile = [{ role: "user", content: [{ type: "text", text: "keep decision" }] }, history[1]];
  const next = await contextCheckpointProjection(store, "chat", "model", mobile);
  expect(next.messages[0].content).toContain("Context checkpoint");
  expect(next.messages[1]).toEqual(history[1]);
});
