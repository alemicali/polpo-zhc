import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";

const token = z.string().regex(/^[\w.:-]{1,100}$/);
const report = z.object({
  topic: z.enum(["app", "voice", "sidebar"]), event: token,
  revision: token, updateId: token, runtime: token, platform: z.enum(["ios", "android", "web", "unknown"]),
  launchId: token, attemptId: token.optional(), code: token.optional(), nativeState: token.optional(),
  elapsedMs: z.number().int().min(0).max(86_400_000).optional(),
  count: z.number().int().min(0).max(1_000_000).optional(),
  granted: z.boolean().optional(), onDevice: z.boolean().optional(),
}).strict();
const stored = report.extend({ receivedAt: z.string(), sequence: z.number() });
const response = { description: "Accepted diagnostic metadata", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } };

/** Ephemeral, bounded diagnostics. No speech, file contents, device IDs or free-form errors. */
export function mobileDiagnosticsRoutes(): OpenAPIHono {
  const app = new OpenAPIHono();
  const entries: z.infer<typeof stored>[] = [];
  let sequence = 0;
  app.use("*", bodyLimit({ maxSize: 2048 }));
  app.openapi(createRoute({ method: "post", path: "/", tags: ["Diagnostics"],
    request: { body: { required: true, content: { "application/json": { schema: report } } } },
    responses: { 200: response },
  }), c => {
    const entry = { ...c.req.valid("json"), sequence: ++sequence, receivedAt: new Date().toISOString() };
    entries.push(entry);
    if (entries.length > 300) entries.splice(0, entries.length - 300);
    console.info("[mobile-diagnostic]", JSON.stringify(entry));
    return c.json({ ok: true }, 200);
  });
  app.openapi(createRoute({ method: "get", path: "/", tags: ["Diagnostics"],
    responses: { 200: { description: "Recent mobile diagnostic metadata", content: { "application/json": {
      schema: z.object({ ok: z.boolean(), data: z.object({ entries: z.array(stored) }) }),
    } } } },
  }), c => {
    c.header("Cache-Control", "no-store");
    const cutoff = Date.now() - 60 * 60 * 1000;
    return c.json({ ok: true, data: { entries: entries.filter(e => Date.parse(e.receivedAt) >= cutoff) } }, 200);
  });
  return app;
}
