import { describe, expect, it } from "vitest";
import { agentRoutes } from "@polpo-ai/server";

describe("GET /agents ETag", () => {
  it("changes when an agent's configuration changes, so clients do not keep a stale list", async () => {
    let agents = [{ name: "writer", role: "Writes drafts", model: "anthropic:claude-sonnet-4-5" }];
    const app = agentRoutes((() => ({ getAgents: async () => agents })) as unknown as Parameters<typeof agentRoutes>[0]);

    for (const path of ["/", "/?summary=true"]) {
      agents = [{ name: "writer", role: "Writes drafts", model: "anthropic:claude-sonnet-4-5" }];
      const first = await app.request(path);
      expect(first.status).toBe(200);
      const etag = first.headers.get("etag")!;
      expect(etag).toBeTruthy();

      expect((await app.request(path, { headers: { "if-none-match": etag } })).status).toBe(304);

      agents = [{ name: "writer", role: "Reviews drafts", model: "anthropic:claude-sonnet-4-5" }];
      const edited = await app.request(path, { headers: { "if-none-match": etag } });
      expect(edited.status).toBe(200);
      expect(edited.headers.get("etag")).not.toBe(etag);
    }
  });
});
