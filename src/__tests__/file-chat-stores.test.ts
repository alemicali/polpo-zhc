import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "../stores/file-session-store.js";
import { FileChatQueueStore } from "../stores/file-chat-queue-store.js";
import { FileAttachmentStore } from "../stores/file-attachment-store.js";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "polpo-chat-stores-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("FileSessionStore — forkSession", () => {
  it("copies the conversation up to a message with new ids and the same timestamps", async () => {
    const dir = tempDir();
    const store = new FileSessionStore(dir);
    const parent = await store.create("Plan", "backend", { scope: "telegram:group:-1" });
    const u1 = await store.addMessage(parent, "user", "first");
    const a1 = await store.addMessage(parent, "assistant", "answer", [{ id: "t1", name: "read", state: "completed" }]);
    const u2 = await store.addMessage(parent, "user", "second");
    await store.addMessage(parent, "assistant", "later");

    const fork = await store.forkSession(parent, u2.id, { title: "Plan (branch)" });
    expect(fork?.session).toMatchObject({ title: "Plan (branch)", agent: "backend", scope: "telegram:group:-1", parentSessionId: parent, forkMessageId: u2.id, messageCount: 3 });
    const copies = await store.getMessages(fork!.session.id);
    expect(copies.map((m) => m.content)).toEqual(["first", "answer", "second"]);
    expect(copies.map((m) => m.ts)).toEqual([u1.ts, a1.ts, u2.ts]);
    expect(copies.map((m) => m.id)).toEqual([fork!.messageIds[u1.id], fork!.messageIds[a1.id], fork!.messageIds[u2.id]]);
    expect(copies[1].toolCalls?.[0].id).toBe("t1");

    // Survives a reload (metadata lives in the JSONL header).
    const reloaded = new FileSessionStore(dir);
    expect(await reloaded.getSession(fork!.session.id)).toMatchObject({ parentSessionId: parent, forkMessageId: u2.id, messageCount: 3 });
    expect(await reloaded.getMessages(parent)).toHaveLength(4);
    expect(await store.forkSession(parent, "missing")).toBeUndefined();
    expect(await store.forkSession("missing", u2.id)).toBeUndefined();
  });
});

describe("FileChatQueueStore", () => {
  it("keeps an ordered per-session queue on disk", async () => {
    const dir = tempDir();
    const q = new FileChatQueueStore(dir);
    expect(await q.get("s1")).toEqual({ items: [], autoSend: true });
    const a = await q.add("s1", "a");
    const b = await q.add("s1", "b");
    await q.add("s1", "z", { front: true });
    await q.add("s2", "other");
    expect((await q.get("s1")).items.map((i) => i.content)).toEqual(["z", "a", "b"]);
    expect((await q.update("s1", a.id, "A"))?.content).toBe("A");
    expect((await q.reorder("s1", [b.id])).map((i) => i.content)).toEqual(["b", "z", "A"]);
    expect((await q.shift("s1"))?.content).toBe("b");
    expect((await q.remove("s1", a.id))?.content).toBe("A");
    await q.setAutoSend("s1", false);

    expect((await q.sessionsWithItems()).sort()).toEqual(["s1", "s2"]);
    const reloaded = new FileChatQueueStore(dir);
    expect(await reloaded.get("s1")).toMatchObject({ autoSend: false, items: [{ content: "z" }] });
    expect(await reloaded.clear("s1")).toBe(1);
    await reloaded.deleteSession("s1");
    expect(await reloaded.get("s1")).toEqual({ items: [], autoSend: true });
    expect((await reloaded.get("s2")).items).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("FileAttachmentStore — getByPath", () => {
  it("lists every row sharing a file", async () => {
    const store = new FileAttachmentStore(tempDir());
    const base = { filename: "a.png", mimeType: "image/png", size: 1, path: "workspace/attachments/s1/x.png", createdAt: new Date().toISOString() };
    await store.save({ ...base, id: "1", sessionId: "s1" });
    await store.save({ ...base, id: "2", sessionId: "s2" });
    await store.save({ ...base, id: "3", sessionId: "s1", path: "other" });
    expect((await store.getByPath(base.path)).map((a) => a.id)).toEqual(["1", "2"]);
  });
});
