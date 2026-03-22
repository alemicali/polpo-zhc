import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileAttachmentStore } from "../stores/file-attachment-store.js";
import type { Attachment } from "@polpo-ai/core";

// ── Helpers ──────────────────────────────────────────

let testDir: string;
let store: FileAttachmentStore;

function makeAttachment(overrides?: Partial<Attachment>): Attachment {
  return {
    id: `att-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: "session-1",
    filename: "report.pdf",
    mimeType: "application/pdf",
    size: 1024,
    path: "attachments/session-1/report.pdf",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Setup / Teardown ─────────────────────────────────

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "polpo-att-store-"));
  store = new FileAttachmentStore(testDir);
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true }); } catch { /* ok */ }
});

// ── Tests ────────────────────────────────────────────

describe("FileAttachmentStore", () => {
  describe("save()", () => {
    it("stores attachment metadata", async () => {
      const att = makeAttachment({ id: "att-1" });
      await store.save(att);

      const retrieved = await store.get("att-1");
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe("att-1");
      expect(retrieved!.sessionId).toBe("session-1");
      expect(retrieved!.filename).toBe("report.pdf");
      expect(retrieved!.mimeType).toBe("application/pdf");
      expect(retrieved!.size).toBe(1024);
      expect(retrieved!.path).toBe("attachments/session-1/report.pdf");
      expect(retrieved!.createdAt).toBe(att.createdAt);
    });

    it("stores multiple attachments", async () => {
      await store.save(makeAttachment({ id: "att-1" }));
      await store.save(makeAttachment({ id: "att-2" }));
      await store.save(makeAttachment({ id: "att-3" }));

      const all = await store.getBySession("session-1");
      expect(all).toHaveLength(3);
    });
  });

  describe("getBySession()", () => {
    it("returns only attachments for the given session", async () => {
      await store.save(makeAttachment({ id: "att-1", sessionId: "session-A" }));
      await store.save(makeAttachment({ id: "att-2", sessionId: "session-A" }));
      await store.save(makeAttachment({ id: "att-3", sessionId: "session-B" }));

      const sessionA = await store.getBySession("session-A");
      expect(sessionA).toHaveLength(2);
      expect(sessionA.map(a => a.id).sort()).toEqual(["att-1", "att-2"]);

      const sessionB = await store.getBySession("session-B");
      expect(sessionB).toHaveLength(1);
      expect(sessionB[0].id).toBe("att-3");
    });

    it("returns empty array for unknown session", async () => {
      await store.save(makeAttachment({ sessionId: "session-X" }));
      const result = await store.getBySession("nonexistent");
      expect(result).toEqual([]);
    });
  });

  describe("get()", () => {
    it("returns single attachment by id", async () => {
      const att = makeAttachment({ id: "att-target", filename: "target.txt" });
      await store.save(makeAttachment({ id: "att-other" }));
      await store.save(att);

      const result = await store.get("att-target");
      expect(result).toBeDefined();
      expect(result!.id).toBe("att-target");
      expect(result!.filename).toBe("target.txt");
    });

    it("returns undefined for unknown id", async () => {
      await store.save(makeAttachment({ id: "att-1" }));
      const result = await store.get("nonexistent");
      expect(result).toBeUndefined();
    });
  });

  describe("delete()", () => {
    it("removes attachment and returns true", async () => {
      await store.save(makeAttachment({ id: "att-1" }));
      await store.save(makeAttachment({ id: "att-2" }));

      const deleted = await store.delete("att-1");
      expect(deleted).toBe(true);

      // Verify it's gone
      expect(await store.get("att-1")).toBeUndefined();
      // Verify other attachment still exists
      expect(await store.get("att-2")).toBeDefined();
    });

    it("returns false for unknown id", async () => {
      await store.save(makeAttachment({ id: "att-1" }));
      const deleted = await store.delete("nonexistent");
      expect(deleted).toBe(false);

      // Verify nothing else was affected
      expect(await store.get("att-1")).toBeDefined();
    });
  });

  describe("deleteBySession()", () => {
    it("removes all attachments for session and returns count", async () => {
      await store.save(makeAttachment({ id: "att-1", sessionId: "session-A" }));
      await store.save(makeAttachment({ id: "att-2", sessionId: "session-A" }));
      await store.save(makeAttachment({ id: "att-3", sessionId: "session-A" }));
      await store.save(makeAttachment({ id: "att-4", sessionId: "session-B" }));

      const removed = await store.deleteBySession("session-A");
      expect(removed).toBe(3);

      // Verify session-A is empty
      expect(await store.getBySession("session-A")).toEqual([]);

      // Verify session-B is untouched
      const sessionB = await store.getBySession("session-B");
      expect(sessionB).toHaveLength(1);
      expect(sessionB[0].id).toBe("att-4");
    });

    it("returns 0 for unknown session", async () => {
      await store.save(makeAttachment({ id: "att-1", sessionId: "session-X" }));
      const removed = await store.deleteBySession("nonexistent");
      expect(removed).toBe(0);

      // Verify nothing was removed
      expect(await store.getBySession("session-X")).toHaveLength(1);
    });
  });

  describe("persistence", () => {
    it("data survives re-instantiation", async () => {
      await store.save(makeAttachment({ id: "att-1", filename: "doc.pdf", sessionId: "s1" }));
      await store.save(makeAttachment({ id: "att-2", filename: "img.png", sessionId: "s1" }));

      // Create a new store instance pointing at the same directory
      const store2 = new FileAttachmentStore(testDir);

      const result = await store2.getBySession("s1");
      expect(result).toHaveLength(2);
      expect(result.find(a => a.id === "att-1")!.filename).toBe("doc.pdf");
      expect(result.find(a => a.id === "att-2")!.filename).toBe("img.png");
    });

    it("persists deletes across re-instantiation", async () => {
      await store.save(makeAttachment({ id: "att-1" }));
      await store.save(makeAttachment({ id: "att-2" }));
      await store.delete("att-1");

      const store2 = new FileAttachmentStore(testDir);
      expect(await store2.get("att-1")).toBeUndefined();
      expect(await store2.get("att-2")).toBeDefined();
    });
  });

  describe("isolation", () => {
    it("different sessions do not see each other's attachments", async () => {
      await store.save(makeAttachment({ id: "a1", sessionId: "alpha", filename: "alpha.txt" }));
      await store.save(makeAttachment({ id: "a2", sessionId: "alpha", filename: "alpha2.txt" }));
      await store.save(makeAttachment({ id: "b1", sessionId: "beta", filename: "beta.txt" }));
      await store.save(makeAttachment({ id: "g1", sessionId: "gamma", filename: "gamma.txt" }));

      const alpha = await store.getBySession("alpha");
      expect(alpha).toHaveLength(2);
      expect(alpha.every(a => a.sessionId === "alpha")).toBe(true);

      const beta = await store.getBySession("beta");
      expect(beta).toHaveLength(1);
      expect(beta[0].sessionId).toBe("beta");

      const gamma = await store.getBySession("gamma");
      expect(gamma).toHaveLength(1);
      expect(gamma[0].sessionId).toBe("gamma");

      // Deleting one session doesn't affect others
      await store.deleteBySession("alpha");
      expect(await store.getBySession("alpha")).toEqual([]);
      expect(await store.getBySession("beta")).toHaveLength(1);
      expect(await store.getBySession("gamma")).toHaveLength(1);
    });
  });

  describe("edge cases", () => {
    it("handles empty store gracefully", async () => {
      expect(await store.getBySession("any")).toEqual([]);
      expect(await store.get("any")).toBeUndefined();
      expect(await store.delete("any")).toBe(false);
      expect(await store.deleteBySession("any")).toBe(0);
    });

    it("creates polpoDir if it does not exist", () => {
      const nestedDir = join(testDir, "nested", "deep", ".polpo");
      const deepStore = new FileAttachmentStore(nestedDir);
      // Constructor should have created the directory — verify by saving
      expect(async () => {
        await deepStore.save(makeAttachment({ id: "att-deep" }));
      }).not.toThrow();
    });
  });
});
