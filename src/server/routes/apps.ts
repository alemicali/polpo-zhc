import { resolve4, resolve6, resolveCname, resolveTxt } from "node:dns/promises";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { nanoid } from "nanoid";
import { chromium } from "playwright-core";
import { z } from "zod";
import { normalizeAppTags, type AppDomain, type AppDomainRecord, type AppRegistryStore, type RegisteredApp } from "../../core/app-registry.js";
import type { AppRuntimeManager } from "../app-runtime-manager.js";

const EnvironmentSchema = z.enum(["development", "preview", "staging", "production"]);
const ServiceSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  kind: z.enum(["frontend", "backend", "worker", "database"]),
  command: z.string().trim().min(1),
  cwd: z.string().trim().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  healthPath: z.string().trim().optional(),
  publicUrl: z.string().url().optional(),
  autoStart: z.boolean().optional(),
});
const DeploymentSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  environment: EnvironmentSchema,
  command: z.string().trim().min(1),
  cwd: z.string().trim().optional(),
  provider: z.string().trim().optional(),
  url: z.string().url().optional(),
  branch: z.string().trim().optional(),
  lastRun: z.any().optional(),
});
const DomainRecordSchema = z.object({
  type: z.enum(["A", "AAAA", "CNAME", "TXT"]),
  name: z.string().trim().min(1),
  value: z.string().trim().min(1),
});
const DomainSchema = z.object({
  id: z.string().trim().min(1).optional(),
  hostname: z.string().trim().min(1),
  environment: EnvironmentSchema,
  deploymentId: z.string().trim().optional(),
  expectedRecords: z.array(DomainRecordSchema).default([]),
  verification: z.any().optional(),
});
const AppSchema = z.object({
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().optional(),
  localPath: z.string().trim().min(1),
  repository: z.object({ url: z.string().trim().min(1), branch: z.string().trim().optional() }).optional(),
  framework: z.string().trim().optional(),
  screenshotUpdatedAt: z.string().datetime().optional(),
  tags: z.array(z.string().trim().min(1)).default([]),
  services: z.array(ServiceSchema).default([]),
  deployments: z.array(DeploymentSchema).default([]),
  domains: z.array(DomainSchema).default([]),
});

export function appsRoutes(getDeps: () => { store: AppRegistryStore; runtime: AppRuntimeManager; polpoDir?: string }): OpenAPIHono {
  const app = new OpenAPIHono();

  app.get("/", async (c) => {
    const { store, runtime } = getDeps();
    const records = await store.list();
    return c.json({ ok: true, data: records.map((record) => withRuntime(record, runtime)) });
  });

  app.post("/", async (c) => {
    const parsed = AppSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid app" }, 400);
    try {
      const normalized = await normalizeApp(parsed.data);
      const created = await getDeps().store.create(normalized);
      return c.json({ ok: true, data: withRuntime(created, getDeps().runtime) }, 201);
    } catch (error) {
      return c.json({ ok: false, error: errorMessage(error) }, 400);
    }
  });

  app.get("/:id", async (c) => {
    const record = await getDeps().store.get(c.req.param("id"));
    return record
      ? c.json({ ok: true, data: withRuntime(record, getDeps().runtime) })
      : c.json({ ok: false, error: "App not found" }, 404);
  });

  app.put("/:id", async (c) => {
    const parsed = AppSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid app" }, 400);
    try {
      const current = await getDeps().store.get(c.req.param("id"));
      if (!current) return c.json({ ok: false, error: "App not found" }, 404);
      const normalized = await normalizeApp(parsed.data, current);
      const updated = await getDeps().store.update(current.id, normalized);
      return c.json({ ok: true, data: withRuntime(updated!, getDeps().runtime) });
    } catch (error) {
      return c.json({ ok: false, error: errorMessage(error) }, 400);
    }
  });

  app.delete("/:id", async (c) => {
    const { store, runtime } = getDeps();
    const record = await store.get(c.req.param("id"));
    if (!record) return c.json({ ok: false, error: "App not found" }, 404);
    await runtime.stopApp(record.id);
    await store.delete(record.id);
    if (getDeps().polpoDir) await rm(screenshotPath(getDeps().polpoDir!, record.id), { force: true }).catch(() => undefined);
    return c.json({ ok: true });
  });

  app.post("/:id/lifecycle/:action", async (c) => {
    const { store, runtime } = getDeps();
    const record = await store.get(c.req.param("id"));
    if (!record) return c.json({ ok: false, error: "App not found" }, 404);
    const action = c.req.param("action");
    try {
      if (action === "stop") {
        await runtime.stopApp(record.id);
        return c.json({ ok: true, data: { statuses: runtime.list(record.id), errors: [] } });
      }
      const result = action === "restart" ? await runtime.restartApp(record.id) : action === "start" ? await runtime.startApp(record.id) : null;
      if (!result) return c.json({ ok: false, error: "Unknown lifecycle action" }, 400);
      return c.json({ ok: result.errors.length === 0, data: result, ...(result.errors.length ? { error: result.errors.join("; ") } : {}) }, result.errors.length ? 207 : 200);
    } catch (error) {
      return c.json({ ok: false, error: errorMessage(error) }, 400);
    }
  });

  app.get("/:id/screenshot", async (c) => {
    const { store, polpoDir } = getDeps();
    if (!polpoDir) return c.json({ ok: false, error: "Screenshot storage is unavailable" }, 501);
    const record = await store.get(c.req.param("id"));
    if (!record?.screenshotUpdatedAt) return c.json({ ok: false, error: "Screenshot not found" }, 404);
    try {
      const data = await readFile(screenshotPath(polpoDir, record.id));
      return new Response(data, { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
    } catch {
      return c.json({ ok: false, error: "Screenshot not found" }, 404);
    }
  });

  app.post("/:id/screenshot", async (c) => {
    const { store, polpoDir } = getDeps();
    if (!polpoDir) return c.json({ ok: false, error: "Screenshot storage is unavailable" }, 501);
    const record = await store.get(c.req.param("id"));
    if (!record) return c.json({ ok: false, error: "App not found" }, 404);
    const body = await c.req.json().catch(() => ({})) as { url?: unknown };
    const candidates = previewCandidates(record);
    const requested = typeof body.url === "string" ? body.url : candidates[0];
    if (!requested || !candidates.some((candidate) => sameUrl(candidate, requested))) {
      return c.json({ ok: false, error: "Choose a URL already configured on this app before capturing a cover" }, 400);
    }
    try {
      const capturedAt = await captureAppScreenshot(record, polpoDir, requested);
      const updated = await store.update(record.id, { screenshotUpdatedAt: capturedAt });
      return c.json({ ok: true, data: withRuntime(updated!, getDeps().runtime) });
    } catch (error) {
      return c.json({ ok: false, error: `Screenshot failed: ${errorMessage(error)}` }, 400);
    }
  });

  app.get("/:id/runtime", async (c) => {
    const record = await getDeps().store.get(c.req.param("id"));
    if (!record) return c.json({ ok: false, error: "App not found" }, 404);
    return c.json({ ok: true, data: getDeps().runtime.list(record.id) });
  });

  app.post("/:id/services/:serviceId/:action", async (c) => {
    const { store, runtime } = getDeps();
    const record = await store.get(c.req.param("id"));
    if (!record) return c.json({ ok: false, error: "App not found" }, 404);
    const serviceId = c.req.param("serviceId");
    const action = c.req.param("action");
    try {
      if (action === "stop") {
        const stopped = await runtime.stop(record.id, "service", serviceId);
        return stopped ? c.json({ ok: true }) : c.json({ ok: false, error: "Service is not running" }, 409);
      }
      const status = action === "restart"
        ? await runtime.restartService(record.id, serviceId)
        : action === "start" ? await runtime.startService(record.id, serviceId) : null;
      return status ? c.json({ ok: true, data: status }) : c.json({ ok: false, error: "Unknown action" }, 400);
    } catch (error) {
      return c.json({ ok: false, error: errorMessage(error) }, 400);
    }
  });

  app.get("/:id/services/:serviceId/health", async (c) => {
    const record = await getDeps().store.get(c.req.param("id"));
    if (!record) return c.json({ ok: false, error: "App not found" }, 404);
    const service = record.services.find((item) => item.id === c.req.param("serviceId"));
    if (!service) return c.json({ ok: false, error: "Service not found" }, 404);
    const url = service.publicUrl ?? (service.port ? `http://127.0.0.1:${service.port}${normalizeHealthPath(service.healthPath)}` : null);
    if (!url) return c.json({ ok: false, error: "Service has no URL or port to probe" }, 400);
    const result = await probeUrl(url);
    return c.json({ ok: true, data: { url, ...result } });
  });

  app.post("/:id/deployments/:deploymentId/run", async (c) => {
    const record = await getDeps().store.get(c.req.param("id"));
    if (!record) return c.json({ ok: false, error: "App not found" }, 404);
    try {
      const status = await getDeps().runtime.runDeployment(record.id, c.req.param("deploymentId"));
      return c.json({ ok: true, data: status }, 202);
    } catch (error) {
      return c.json({ ok: false, error: errorMessage(error) }, 400);
    }
  });

  app.post("/:id/deployments/:deploymentId/stop", async (c) => {
    const record = await getDeps().store.get(c.req.param("id"));
    if (!record) return c.json({ ok: false, error: "App not found" }, 404);
    const stopped = await getDeps().runtime.stop(record.id, "deployment", c.req.param("deploymentId"));
    return stopped ? c.json({ ok: true }) : c.json({ ok: false, error: "Deployment is not running" }, 409);
  });

  app.post("/:id/domains/:domainId/verify", async (c) => {
    const { store } = getDeps();
    const record = await store.get(c.req.param("id"));
    if (!record) return c.json({ ok: false, error: "App not found" }, 404);
    const domain = record.domains.find((item) => item.id === c.req.param("domainId"));
    if (!domain) return c.json({ ok: false, error: "Domain not found" }, 404);
    const verification = await verifyAppDomain(domain);
    const domains = record.domains.map((item) => item.id === domain.id ? { ...item, verification } : item);
    const updated = await store.update(record.id, { domains });
    return c.json({ ok: true, data: updated?.domains.find((item) => item.id === domain.id) });
  });

  return app;
}

function withRuntime(record: RegisteredApp, runtime: AppRuntimeManager) {
  return { ...record, runtime: runtime.list(record.id) };
}

function previewCandidates(app: RegisteredApp): string[] {
  const urls = [
    ...app.services.flatMap((service) => [service.publicUrl, service.port ? `http://127.0.0.1:${service.port}/` : undefined]),
    ...app.deployments.map((deployment) => deployment.url),
    ...app.domains.map((domain) => `https://${domain.hostname}/`),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(urls)];
}

function sameUrl(left: string, right: string): boolean {
  try { return new URL(left).href === new URL(right).href; } catch { return false; }
}

function screenshotPath(polpoDir: string, appId: string): string {
  return join(polpoDir, "app-screenshots", `${appId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.png`);
}

export async function removeAppScreenshot(polpoDir: string, appId: string): Promise<void> {
  await rm(screenshotPath(polpoDir, appId), { force: true });
}

export async function captureAppScreenshot(app: RegisteredApp, polpoDir: string, requestedUrl?: string): Promise<string> {
  const candidates = previewCandidates(app);
  const requested = requestedUrl ?? candidates[0];
  if (!requested || !candidates.some((candidate) => sameUrl(candidate, requested))) {
    throw new Error("Choose a URL already configured on this app before capturing a cover");
  }
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.POLPO_CHROMIUM_EXECUTABLE || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(requested, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(750);
    await mkdir(join(polpoDir, "app-screenshots"), { recursive: true });
    await page.screenshot({ path: screenshotPath(polpoDir, app.id), type: "png", animations: "disabled" });
    return new Date().toISOString();
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function normalizeApp(input: z.infer<typeof AppSchema>, current?: RegisteredApp) {
  const localPath = resolve(input.localPath);
  const pathStat = await stat(localPath).catch(() => null);
  if (!pathStat?.isDirectory()) throw new Error(`Local path is not a directory: ${localPath}`);
  const keepId = <T extends { id?: string }>(item: T, previous: Array<{ id: string; name?: string; hostname?: string }>) =>
    item.id ?? previous.find((candidate) => candidate.name === (item as any).name || candidate.hostname === (item as any).hostname)?.id ?? nanoid();
  return {
    ...input,
    localPath,
    tags: normalizeAppTags(input.tags),
    services: input.services.map((item) => ({ ...item, id: keepId(item, current?.services ?? []) })),
    deployments: input.deployments.map((item) => ({ ...item, id: keepId(item, current?.deployments ?? []) })),
    domains: input.domains.map((item) => ({
      ...item,
      hostname: normalizeHostname(item.hostname),
      id: keepId(item, current?.domains ?? []),
      verification: current?.domains.find((domain) => domain.id === item.id || domain.hostname === normalizeHostname(item.hostname))?.verification
        ?? { status: "unchecked" as const },
    })),
  };
}

export function normalizeHostname(value: string): string {
  const candidate = value.includes("://") ? new URL(value).hostname : value.split("/")[0]!;
  return candidate.trim().replace(/\.$/, "").toLowerCase();
}

export async function verifyAppDomain(domain: AppDomain) {
  const details: string[] = [];
  let recordsOk = true;
  for (const record of domain.expectedRecords) {
    const actual = await resolveRecord(record).catch((error) => {
      details.push(`${record.type} ${record.name}: ${errorMessage(error)}`);
      return [];
    });
    const expected = normalizeDnsValue(record.value);
    const matches = actual.some((value) => normalizeDnsValue(value) === expected);
    recordsOk &&= matches;
    details.push(`${record.type} ${record.name}: ${matches ? "matched" : `expected ${record.value}, got ${actual.join(", ") || "no record"}`}`);
  }
  const http = await probeUrl(`https://${domain.hostname}`);
  details.push(`HTTPS: ${http.ok ? `reachable (${http.status})` : http.error ?? "unreachable"}`);
  return {
    status: recordsOk && http.ok ? "valid" as const : "invalid" as const,
    checkedAt: new Date().toISOString(),
    details,
    httpOk: http.ok,
  };
}

async function resolveRecord(record: AppDomainRecord): Promise<string[]> {
  if (record.type === "A") return resolve4(record.name);
  if (record.type === "AAAA") return resolve6(record.name);
  if (record.type === "CNAME") return resolveCname(record.name);
  return (await resolveTxt(record.name)).map((parts) => parts.join(""));
}

function normalizeDnsValue(value: string): string {
  return value.trim().replace(/\.$/, "").toLowerCase();
}

function normalizeHealthPath(value?: string): string {
  if (!value) return "/";
  return value.startsWith("/") ? value : `/${value}`;
}

async function probeUrl(url: string): Promise<{ ok: boolean; status?: number; latencyMs: number; error?: string }> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    return { ok: response.status < 500, status: response.status, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: errorMessage(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
