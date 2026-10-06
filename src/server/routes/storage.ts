import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { nanoid } from "nanoid";
import { validateStorageEntry, type StorageEntry } from "@polpo-ai/core/storage-registry";
import type { StorageRuntime } from "../../storage/runtime.js";

/**
 * Storage buckets (S3, Cloudflare R2, MinIO, B2, Wasabi…): registry CRUD, credentials (accepted,
 * never returned: responses say only "set" / "not set"), connection test, mount and unmount.
 */

const CredentialsSchema = z.object({
  accessKeyId: z.string().trim().min(1),
  secretAccessKey: z.string().trim().min(1),
  sessionToken: z.string().trim().optional(),
});

/** Temporary keys per run for remote sandboxes; null goes back to the fixed sandbox key. */
const TemporarySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("r2"), accountId: z.string().trim().min(1), parentAccessKeyId: z.string().trim().min(1), apiToken: z.string().trim().optional() }),
  z.object({ kind: z.literal("sts"), roleArn: z.string().trim().min(1), endpoint: z.string().trim().optional() }),
]).nullable();

const GrantSchema = z.object({
  id: z.string().optional(),
  agent: z.string().trim().min(1),
  access: z.enum(["read", "write"]),
  prefix: z.string().trim().optional(),
});

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
  /** Write-only. */
  credentials: CredentialsSchema.optional(),
  /** Write-only; null removes them. */
  sandboxCredentials: CredentialsSchema.nullable().optional(),
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
  description: "Omitted credentials stay as they are. Changing mount settings remounts the bucket.",
  request: { params: idParam, body: { content: { "application/json": { schema: EntrySchema } } } },
  responses: {
    200: { content: { "application/json": { schema: okAny } }, description: "Updated" },
    400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid" },
    404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
  },
});
const deleteRoute = createRoute({
  method: "delete", path: "/{id}", tags: ["Storage"], summary: "Remove a storage bucket",
  description: "Unmounts it and deletes its credentials. The bucket and its files are not touched.",
  request: { params: idParam },
  responses: {
    200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Removed" },
    404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
  },
});
const credentialsRoute = createRoute({
  method: "put", path: "/{id}/credentials", tags: ["Storage"], summary: "Set storage credentials",
  description: "Stored in the vault (system namespace). `sandboxCredentials`: a dedicated, limited key for remote sandboxes; null removes it. `temporary`: mint temporary keys per task run instead (R2: account id, parent access key id, API token; S3/MinIO: STS role ARN); null goes back to the fixed key. The API token is never returned.",
  request: {
    params: idParam,
    body: { content: { "application/json": { schema: z.object({ credentials: CredentialsSchema.optional(), sandboxCredentials: CredentialsSchema.nullable().optional(), temporary: TemporarySchema.optional() }) } } },
  },
  responses: {
    200: { content: { "application/json": { schema: okAny } }, description: "Updated" },
    400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid" },
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
  const { credentials: _c, sandboxCredentials: _s, ...rest } = input;
  return {
    ...rest,
    endpoint: rest.endpoint || undefined,
    region: rest.region || undefined,
    prefix: rest.prefix || undefined,
    description: rest.description || undefined,
    grants: rest.grants.map((grant) => ({ ...grant, id: grant.id ?? nanoid(), prefix: grant.prefix || undefined })),
  };
}

export function storageRoutes(getRuntime: () => StorageRuntime): OpenAPIHono {
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
      const created = await getRuntime().create(entry, { credentials: input.credentials, sandboxCredentials: input.sandboxCredentials });
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
      const updated = await getRuntime().update(c.req.valid("param").id, entry, { credentials: input.credentials, sandboxCredentials: input.sandboxCredentials });
      return updated ? c.json({ ok: true, data: updated }, 200) : notFound(c);
    } catch (error) { return failure(c, error); }
  }) as any);

  app.openapi(deleteRoute, (async (c: any) => {
    try {
      return (await getRuntime().delete(c.req.valid("param").id)) ? c.json({ ok: true }, 200) : notFound(c);
    } catch (error) { return failure(c, error); }
  }) as any);

  app.openapi(credentialsRoute, (async (c: any) => {
    const body = c.req.valid("json");
    try {
      const updated = await getRuntime().update(c.req.valid("param").id, {}, body);
      return updated ? c.json({ ok: true, data: updated }, 200) : notFound(c);
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

  app.openapi(statusRoute, (async (c: any) => {
    const runtime = getRuntime();
    const entry = await runtime.entry(c.req.valid("param").id);
    return entry ? c.json({ ok: true, data: runtime.mountStatus(entry) }, 200) : notFound(c);
  }) as any);

  return app;
}

function notFound(c: any) { return c.json({ ok: false, error: "Storage not found" }, 404); }
function failure(c: any, error: unknown) { return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400); }
