import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRoutes } from "@polpo-ai/server";
import { NodeFileSystem } from "../adapters/node-filesystem.js";

// A tiny JPEG header and a few bytes: what matters is that the file on disk holds these bytes.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

describe("POST /agents/:name/avatar", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("stores the image's bytes, not their base64 text", async () => {
    dir = mkdtempSync(join(tmpdir(), "polpo-avatar-"));
    let identity: Record<string, unknown> | undefined;
    const app = agentRoutes((() => ({
      getAgents: async () => [{ name: "foreman", role: "Builds" }],
      updateAgent: async (_name: string, updates: { identity?: Record<string, unknown> }) => { identity = updates.identity; },
      polpoDir: dir,
      fs: new NodeFileSystem(),
    })) as unknown as Parameters<typeof agentRoutes>[0]);

    const form = new FormData();
    form.append("file", new File([JPEG], "foreman.jpg", { type: "image/jpeg" }));
    const res = await app.request("/foreman/avatar", { method: "POST", body: form });
    expect(res.status).toBe(200);
    expect(identity?.avatar).toBe(".polpo/avatars/foreman.jpg");

    const saved = readFileSync(join(dir, "avatars", "foreman.jpg"));
    expect(saved.byteLength).toBe(JPEG.byteLength);
    expect(saved.equals(JPEG)).toBe(true);
  });
});
