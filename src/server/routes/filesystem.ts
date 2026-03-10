import { existsSync, readdirSync, renameSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

// ── Route definitions ─────────────────────────────────────────────────

const browseRoute = createRoute({
  method: "get",
  path: "/browse",
  tags: ["Filesystem"],
  summary: "Browse filesystem directories",
  request: {
    query: z.object({ path: z.string().optional() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            data: z.object({
              current: z.string(),
              parent: z.string().nullable(),
              dirs: z.array(z.object({
                name: z.string(),
                path: z.string(),
                hasPolpoConfig: z.boolean(),
              })),
            }),
          }),
        },
      },
      description: "Directory listing",
    },
  },
});

const mkdirRoute = createRoute({
  method: "post",
  path: "/mkdir",
  tags: ["Filesystem"],
  summary: "Create a new directory",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ path: z.string() }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ path: z.string() }) }) } },
      description: "Directory created",
    },
  },
});

const renameRoute = createRoute({
  method: "post",
  path: "/rename",
  tags: ["Filesystem"],
  summary: "Rename a directory",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ path: z.string(), newName: z.string() }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ path: z.string() }) }) } },
      description: "Directory renamed",
    },
  },
});

// ── Route handlers ──────────────────────────────────────────────────

export function filesystemRoutes(): OpenAPIHono {
  const app = new OpenAPIHono();

  // GET /filesystem/browse
  app.openapi(browseRoute, (c) => {
    const requestedPath = c.req.query("path") || homedir();
    const target = resolve(requestedPath);

    if (!existsSync(target)) {
      return c.json({
        ok: true,
        data: { current: target, parent: dirname(target), dirs: [] },
      });
    }

    try {
      const entries = readdirSync(target, { withFileTypes: true });
      const dirs = entries
        .filter((e) => {
          if (!e.isDirectory()) return false;
          if (e.name.startsWith(".") && e.name !== ".polpo") return false;
          return true;
        })
        .map((e) => {
          const fullPath = join(target, e.name);
          const hasPolpoConfig = existsSync(join(fullPath, ".polpo", "polpo.json"));
          return { name: e.name, path: fullPath, hasPolpoConfig };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      const parentDir = dirname(target);
      return c.json({
        ok: true,
        data: {
          current: target,
          parent: parentDir !== target ? parentDir : null,
          dirs,
        },
      });
    } catch {
      return c.json({
        ok: true,
        data: { current: target, parent: dirname(target), dirs: [] },
      });
    }
  });

  // POST /filesystem/mkdir
  app.openapi(mkdirRoute, (c: any) => {
    const { path: dirPath } = c.req.valid("json");
    const target = resolve(dirPath);
    try {
      mkdirSync(target, { recursive: true });
      return c.json({ ok: true, data: { path: target } });
    } catch (err: unknown) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : "Failed to create directory" }, 400);
    }
  });

  // POST /filesystem/rename
  app.openapi(renameRoute, (c: any) => {
    const { path: dirPath, newName } = c.req.valid("json");
    const target = resolve(dirPath);
    const newPath = join(dirname(target), newName);
    try {
      renameSync(target, newPath);
      return c.json({ ok: true, data: { path: newPath } });
    } catch (err: unknown) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : "Rename failed" }, 400);
    }
  });

  return app;
}
