import { resolve as resolvePath, sep } from "node:path";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { nanoid } from "nanoid";
import { validateStorageEntry, type StorageEntry } from "@polpo-ai/core/storage-registry";
import type { StorageRuntime } from "../../storage/runtime.js";

/**
 * Storage buckets (S3, Cloudflare R2, MinIO, B2, Wasabi…): registry CRUD, connection test, mount
 * and unmount. Keys are not sent here: an entry references the vault entries that hold them
 * (owner + service); responses say only whether each one resolves ("set" / "not set").
 */

/** An existing vault entry: an agent's (possibly shared), never a system "$" owner. */
const VaultRefSchema = z.object({
  owner: z.string().trim().min(1).refine((o) => !o.startsWith("$"), { message: "System vault owners cannot be referenced" }),
  service: z.string().trim().min(1),
});

/** Temporary keys per run for remote sandboxes; omitted/null = the fixed sandbox key. */
const TemporarySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("r2"), accountId: z.string().trim().min(1), parentAccessKeyId: z.string().trim().min(1), token: VaultRefSchema.optional() }),
  z.object({ kind: z.literal("sts"), roleArn: z.string().trim().min(1), endpoint: z.string().trim().optional() }),
]).nullable();

const GrantSchema = z.object({
  id: z.string().optional(),
  agent: z.string().trim().min(1),
  access: z.enum(["read", "write"]),
  prefix: z.string().trim().optional(),
  /** Sandbox volume: this agent's hydrated write-back ("manual" = only on checkpoint). */
  writeBack: z.enum(["auto", "manual"]).optional(),
});

/** Sandbox volume (open Polpo): the bucket appears at /volumes/<slug> in the sandboxes that select it. */
const VolumeSchema = z.object({
  enabled: z.boolean(),
  strategy: z.enum(["mounted", "hydrated"]).default("mounted"),
  access: z.enum(["read-only", "read-write"]).default("read-write"),
  writeBack: z.enum(["auto", "manual"]).optional(),
  label: z.string().trim().optional(),
}).nullable();

const EntrySchema = z.object({
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  description: z.string().trim().optional(),
  provider: z.literal("s3").default("s3"),
  endpoint: z.string().trim().optional(),
  region: z.string().trim().optional(),
  bucket: z.string().trim().min(1),
  prefix: z.string().trim().optional(),
  pathStyle: z.boolean().optional(),
  driver: z.enum(["rclone", "mountpoint-s3"]).default("rclone"),
  readOnly: z.boolean().default(false),
  cache: z.object({
    mode: z.enum(["writes", "full"]).optional(),
    maxSizeMb: z.number().int().min(64).max(1_048_576).optional(),
    maxAgeHours: z.number().int().min(1).max(8_760).optional(),
  }).optional(),
  enabled: z.boolean().default(true),
  grants: z.array(GrantSchema).default([]),
  /** Vault entry with the main keys (access key id + secret). */
  credentials: VaultRefSchema.nullable().optional(),
  /** Vault entry with limited keys for remote sandboxes. */
  sandboxCredentials: VaultRefSchema.nullable().optional(),
  /** Temporary keys per run (R2 token in a vault entry, or STS role). */
  temporaryCredentials: TemporarySchema.optional(),
  volume: VolumeSchema.optional(),
});

const errorSchema = z.object({ ok: z.literal(false), error: z.string() });
const okAny = z.object({ ok: z.literal(true), data: z.any() });
const idParam = z.object({ id: z.string().openapi({ description: "Storage id or slug" }) });

const listRoute = createRoute({
  method: "get", path: "/", tags: ["Storage"], summary: "List storage buckets",
  description: "Registered buckets with grants, whether credentials are set (never their values) and mount status.",
  responses: { 200: { content: { "application/json": { schema: okAny } }, description: "Storage entries" } },
});
const createEntryRoute = createRoute({
  method: "post", path: "/", tags: ["Storage"], summary: "Register a storage bucket",
  request: { body: { content: { "application/json": { schema: EntrySchema } } } },
  responses: {
    201: { content: { "application/json": { schema: okAny } }, description: "Created" },
    400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid" },
  },
});
const getRoute = createRoute({
  method: "get", path: "/{id}", tags: ["Storage"], summary: "Get a storage bucket",
  request: { params: idParam },
  responses: {
    200: { content: { "application/json": { schema: okAny } }, description: "Storage entry" },
    404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
  },
});
const updateRoute = createRoute({
  method: "put", path: "/{id}", tags: ["Storage"], summary: "Update a storage bucket",
  description: "Changing mount settings or the main vault entry remounts the bucket.",
  request: { params: idParam, body: { content: { "application/json": { schema: EntrySchema } } } },
  responses: {
    200: { content: { "application/json": { schema: okAny } }, description: "Updated" },
    400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid" },
    404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
  },
});
const deleteRoute = createRoute({
  method: "delete", path: "/{id}", tags: ["Storage"], summary: "Remove a storage bucket",
  description: "Unmounts it. The bucket, its files and the vault entries are not touched.",
  request: { params: idParam },
  responses: {
    200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Removed" },
    404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
  },
});
const actionRoute = (path: string, summary: string, description: string) => createRoute({
  method: "post", path, tags: ["Storage"], summary, description,
  request: { params: idParam },
  responses: {
    200: { content: { "application/json": { schema: okAny } }, description: "Result" },
    400: { content: { "application/json": { schema: errorSchema } }, description: "Failed" },
    404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
  },
});
const testRoute = actionRoute("/{id}/test", "Test a storage connection", "Lists at most one object with the stored credentials.");
const mountRoute = actionRoute("/{id}/mount", "Mount a storage bucket", "Mounts (or remounts) the bucket on this server.");
const unmountRoute = actionRoute("/{id}/unmount", "Unmount a storage bucket", "Unmounts the bucket on this server.");
const statusRoute = createRoute({
  method: "get", path: "/{id}/status", tags: ["Storage"], summary: "Mount status of a storage bucket",
  request: { params: idParam },
  responses: {
    200: { content: { "application/json": { schema: okAny } }, description: "Mount status" },
    404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
  },
});

type EntryInput = z.infer<typeof EntrySchema>;

function toEntry(input: EntryInput): Omit<StorageEntry, "id" | "createdAt" | "updatedAt"> {
  const { credentials, sandboxCredentials, temporaryCredentials, volume, ...rest } = input;
  return {
    ...rest,
    volume: volume ?? undefined,
    credentials: credentials ?? undefined,
    sandboxCredentials: sandboxCredentials ?? undefined,
    temporaryCredentials: temporaryCredentials ?? undefined,
    endpoint: rest.endpoint || undefined,
    region: rest.region || undefined,
    prefix: rest.prefix || undefined,
    description: rest.description || undefined,
    grants: rest.grants.map((grant) => ({ ...grant, id: grant.id ?? nanoid(), prefix: grant.prefix || undefined })),
  };
}

const importRoute = createRoute({
  method: "post", path: "/{id}/import", tags: ["Storage"], summary: "Copy a folder into the bucket",
  description: "Copies a folder of the project (path relative to the working directory) into the bucket, under an optional prefix, in the background. Dependencies (node_modules, .venv) and .git are skipped; the folder is not touched.",
  request: { params: idParam, body: { content: { "application/json": { schema: z.object({ source: z.string().trim().min(1), target: z.string().trim().optional() }) } } } },
  responses: {
    202: { content: { "application/json": { schema: okAny } }, description: "Started" },
    400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid" },
    404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
  },
});
const importStatusRoute = createRoute({
  method: "get", path: "/{id}/import/{job}", tags: ["Storage"], summary: "Folder copy status",
  request: { params: z.object({ id: z.string(), job: z.string() }) },
  responses: {
    200: { content: { "application/json": { schema: okAny } }, description: "Status" },
    404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
  },
});

export function storageRoutes(getRuntime: () => StorageRuntime, getWorkDir?: () => string): OpenAPIHono {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ ok: false, error: result.error.issues[0]?.message ?? "Invalid request" }, 400);
    },
  });

  app.openapi(listRoute, (async (c: any) => c.json({ ok: true, data: await getRuntime().list() }, 200)) as any);

  app.openapi(createEntryRoute, (async (c: any) => {
    const input = c.req.valid("json") as EntryInput;
    const entry = toEntry(input);
    const problem = validateStorageEntry(entry);
    if (problem) return c.json({ ok: false, error: problem }, 400);
    try {
      const created = await getRuntime().create(entry);
      return c.json({ ok: true, data: created }, 201);
    } catch (error) { return failure(c, error); }
  }) as any);

  app.openapi(getRoute, (async (c: any) => {
    const entry = await getRuntime().get(c.req.valid("param").id);
    return entry ? c.json({ ok: true, data: entry }, 200) : notFound(c);
  }) as any);

  app.openapi(updateRoute, (async (c: any) => {
    const input = c.req.valid("json") as EntryInput;
    const entry = toEntry(input);
    const problem = validateStorageEntry(entry);
    if (problem) return c.json({ ok: false, error: problem }, 400);
    try {
      const updated = await getRuntime().update(c.req.valid("param").id, entry);
      return updated ? c.json({ ok: true, data: updated }, 200) : notFound(c);
    } catch (error) { return failure(c, error); }
  }) as any);

  app.openapi(deleteRoute, (async (c: any) => {
    try {
      return (await getRuntime().delete(c.req.valid("param").id)) ? c.json({ ok: true }, 200) : notFound(c);
    } catch (error) { return failure(c, error); }
  }) as any);

  app.openapi(testRoute, (async (c: any) => {
    const runtime = getRuntime();
    const id = c.req.valid("param").id;
    if (!(await runtime.entry(id))) return notFound(c);
    try { return c.json({ ok: true, data: await runtime.test(id) }, 200); }
    catch (error) { return failure(c, error); }
  }) as any);

  app.openapi(mountRoute, (async (c: any) => {
    const runtime = getRuntime();
    const id = c.req.valid("param").id;
    if (!(await runtime.entry(id))) return notFound(c);
    try {
      const status = await runtime.mount(id);
      return status.state === "error" ? c.json({ ok: false, error: status.error ?? "Mount failed" }, 400) : c.json({ ok: true, data: status }, 200);
    } catch (error) { return failure(c, error); }
  }) as any);

  app.openapi(unmountRoute, (async (c: any) => {
    const runtime = getRuntime();
    const id = c.req.valid("param").id;
    if (!(await runtime.entry(id))) return notFound(c);
    try { return c.json({ ok: true, data: await runtime.unmount(id) }, 200); }
    catch (error) { return failure(c, error); }
  }) as any);

  app.openapi(importRoute, (async (c: any) => {
    const runtime = getRuntime();
    const id = c.req.valid("param").id;
    if (!(await runtime.entry(id))) return notFound(c);
    const { source, target } = c.req.valid("json");
    const root = resolvePath(getWorkDir?.() ?? process.cwd());
    const dir = resolvePath(root, source);
    if (dir !== root && !dir.startsWith(root + sep)) return c.json({ ok: false, error: "The folder must be inside the project's working directory" }, 400);
    try { return c.json({ ok: true, data: await runtime.importFolder(id, dir, target) }, 202); }
    catch (error) { return failure(c, error); }
  }) as any);

  app.openapi(importStatusRoute, (async (c: any) => {
    const job = getRuntime().importStatus(c.req.valid("param").job);
    return job ? c.json({ ok: true, data: job }, 200) : c.json({ ok: false, error: "Copy not found" }, 404);
  }) as any);

  app.openapi(statusRoute, (async (c: any) => {
    const runtime = getRuntime();
    const entry = await runtime.entry(c.req.valid("param").id);
    return entry ? c.json({ ok: true, data: runtime.mountStatus(entry) }, 200) : notFound(c);
  }) as any);

  return app;
}

function notFound(c: any) { return c.json({ ok: false, error: "Storage not found" }, 404); }
function failure(c: any, error: unknown) { return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400); }
