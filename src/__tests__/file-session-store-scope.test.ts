import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "../stores/file-session-store.js";

describe("FileSessionStore — scoped sessions", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("keeps the scope across reloads and never returns a scoped session as the latest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polpo-sessions-"));
    dirs.push(dir);
    const store = new FileSessionStore(dir);
    const web = await store.create("web", "backend");
    await new Promise((r) => setTimeout(r, 15));
    const group = await store.create("Team", "backend", { scope: "telegram:group:-1" });
    await store.addMessage(group, "user", "Ada: hi");

    const reloaded = new FileSessionStore(dir);
    expect((await reloaded.getSession(group))?.scope).toBe("telegram:group:-1");
    expect((await reloaded.getLatestSession("backend"))?.id).toBe(web);
    expect((await reloaded.getLatestSession())?.id).toBe(web);
  });
});
