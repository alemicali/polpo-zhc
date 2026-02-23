import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { rateLimitMiddleware } from "../server/middleware/rate-limit.js";

function createTestApp(maxReqs: number, windowMs: number) {
  const app = new Hono();
  app.use("*", rateLimitMiddleware(maxReqs, windowMs));
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}

describe("rateLimitMiddleware", () => {
  it("allows requests under the limit", async () => {
    const app = createTestApp(5, 60_000);
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/");
      expect(res.status).toBe(200);
    }
  });

  it("blocks requests over the limit with 429", async () => {
    const app = createTestApp(3, 60_000);
    // First 3 should pass
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/");
      expect(res.status).toBe(200);
    }
    // 4th should be rate-limited
    const res = await app.request("/");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("includes Retry-After header on 429", async () => {
    const app = createTestApp(1, 60_000);
    await app.request("/"); // First request OK
    const res = await app.request("/"); // Should be 429
    expect(res.status).toBe(429);
    const retryAfter = res.headers.get("retry-after");
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("resets after window expires", async () => {
    // Use a very short window so it expires quickly
    const app = createTestApp(1, 1);
    await app.request("/"); // First OK
    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 10));
    const res = await app.request("/"); // New window, should be OK
    expect(res.status).toBe(200);
  });

  it("tracks different IPs separately", async () => {
    const app = createTestApp(1, 60_000);
    // IP A
    const res1 = await app.request("/", { headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(res1.status).toBe(200);
    const res2 = await app.request("/", { headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(res2.status).toBe(429);
    // IP B should still work
    const res3 = await app.request("/", { headers: { "x-forwarded-for": "5.6.7.8" } });
    expect(res3.status).toBe(200);
  });

  it("uses default values when no params provided", async () => {
    const app = new Hono();
    app.use("*", rateLimitMiddleware());
    app.get("/", (c) => c.json({ ok: true }));
    // Should allow at least 200 requests (default)
    const res = await app.request("/");
    expect(res.status).toBe(200);
  });
});
