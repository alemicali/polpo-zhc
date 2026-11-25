/**
 * Hosted MCP servers: create, edit the draft, test, publish, deploy, roll back, delete — and the
 * connector bound to each server. Used by the REST routes (and through them by the MCP tools,
 * Polpo's chat and the SDK).
 */
import { randomUUID } from "node:crypto";
import type { ConnectorConfig, VaultStore } from "@polpo-ai/core";
import { CONNECTOR_ID_PATTERN } from "@polpo-ai/core";
import type { ConnectorManager } from "../mcp/manager.js";
import type { HostedServerSuiteSettings } from "@polpo-ai/core/agent-suites";
import { runTool, secretStatus, type HostedRuntimeDeps } from "./runtime.js";
import type { FetchLike } from "./http-executor.js";
import { McpServerStore } from "./store.js";
import { McpServerInputError, normalizeSpec, specProblems } from "./validate.js";
import { compareSemver, nextVersion, specChanges, specsEqual, suggestBump, unifiedSpecDiff } from "./versioning.js";
import { effectiveSettings, validateSettings } from "./settings.js";
import { MCP_SERVER_TEMPLATES, serverTemplate, type McpServerTemplate } from "./templates/index.js";
import { HOSTED_SERVER_ICON_FILES } from "./icons.js";
import {
  DEFAULT_RATE_LIMITS, isSensitiveTool, MCP_SERVER_ID_PATTERN,
  type McpSecretRef, type McpServerBump, type McpServerDeploy, type McpServerMeta, type McpServerSpec, type McpServerTestCase, type McpServerVersion,
  type McpServerVisibility, type McpToolCallResult, type PendingCall, type PublicRateLimits,
} from "./types.js";

/** Where a template stands on this instance. */
export type TemplateStatus = "available" | "draft" | "installed" | "update_available";

export interface InstallOptions {
  /** The server id (default: the template's id, or the server already made from it). */
  id?: string;
  /** Settings values (validated against the template's settingsSchema). */
  settings?: Record<string, unknown>;
  /** Secret values to save in the vault first (dashboard only: never echoed back). */
  secrets?: Record<string, unknown>;
  /** Agents the connector grants ("*": all). Default: none (Polpo only). */
  agents?: string[] | "*";
  /** false: stop after the checks (a draft). Default true: publish v1.0.0 and deploy. */
  publish?: boolean;
  /** Publish even when a saved test fails. */
  force?: boolean;
}

export interface InstallResult {
  id: string;
  template: string;
  revision: number;
  /**
   * installed: published and deployed; needs_secrets: a secret is not in the vault yet (nothing
   * published); tests_failed: a read-only test failed (nothing published); draft: checks passed,
   * not published (publish: false); upgrade_draft: a newer template revision became the draft (diff);
   * up_to_date: already on this revision.
   */
  status: "installed" | "needs_secrets" | "tests_failed" | "draft" | "upgrade_draft" | "up_to_date";
  missingSecrets?: string[];
  tests?: { passed: number; failed: number; skipped: number; results: TestRunResult[] };
  version?: string;
  deployed?: McpServerDeploy;
  diff?: ReturnType<McpServerService["diff"]>;
  connectorId?: string;
  access?: { agents: string[] | "*"; polpo: boolean };
  settings: Record<string, string | number | boolean>;
}

export class McpServerError extends Error {
  constructor(message: string, readonly code: "NOT_FOUND" | "INVALID" | "CONFLICT" | "TESTS_FAILED" | "GATE_BLOCKED" | "FORBIDDEN" = "INVALID", readonly details?: unknown) {
    super(message);
  }
}

/**
 * The deploy gate of a hosted server: its suite (the saved tests with gate.required) run against
 * the version; the deploy happens only when it passes (docs/agent-suites.md).
 */
export type HostedSuiteGate = (id: string, version: string, opts: { actor: string }) => Promise<{ passed: boolean; runId?: string; failures: string[] }>;

/**
 * The saved tests run as the server's suite (HTTP mocked per case) on a ref: publish's check. Returns
 * undefined when the suite cannot run that way (no cases, or cases that need real HTTP): the
 * legacy live run of the saved tests is used then.
 */
export type HostedSuiteCheck = (id: string, ref: string, opts: { actor: string }) => Promise<{ passed: number; failed: number; skipped: number; runId?: string } | undefined>;

/** A vault that answers every secret with a placeholder: suite calls whose HTTP is mocked never read a real secret. */
function placeholderVault(): VaultStore {
  const entry = { type: "api_key", label: "test", credentials: new Proxy({} as Record<string, string>, { get: (_t, k) => (typeof k === "string" ? `polpo-test-${k}` : undefined) }) };
  return { get: async () => entry } as unknown as VaultStore;
}

/** Builds code tools (installs npm deps) for a version; see code-build.ts. */
export type CodeBuilder = (args: { serverId: string; versionKey: string; spec: McpServerSpec; buildDir: string }) => Promise<{ lockfile?: string; depsBytes?: number }>;

export interface McpServerServiceDeps {
  polpoDir: string;
  vault: () => VaultStore | undefined;
  /** The connector manager (the bound connector is created / updated / closed through it). */
  connectors?: () => ConnectorManager;
  /** Runtime dependencies (code runner, approval hook, tests' fetch). */
  runtime?: () => Partial<HostedRuntimeDeps>;
  build?: CodeBuilder;
  /** Announce a change (SSE: mcp-server:changed). */
  changed?: (id: string, what: string) => void;
  /** The deploy gate: the server's required suite run against a version before it reaches production. */
  suiteGate?: () => HostedSuiteGate | undefined;
  /** Publish's check: the saved tests run as the suite (HTTP mocked), else the legacy live run. */
  suiteCheck?: () => HostedSuiteCheck | undefined;
}

export interface TestRunResult extends McpToolCallResult {
  tool: string;
  skipped?: string;
  testId?: string;
  passed?: boolean;
}

const SLUG = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "server";

export class McpServerService {
  readonly store: McpServerStore;

  constructor(private readonly deps: McpServerServiceDeps) {
    this.store = new McpServerStore(deps.polpoDir);
  }

  private runtimeDeps(): HostedRuntimeDeps {
    return { polpoDir: this.deps.polpoDir, ...(this.deps.vault() ? { vault: this.deps.vault() } : {}), ...(this.deps.runtime?.() ?? {}) };
  }

  private need(id: string): McpServerMeta {
    const meta = this.store.meta(id);
    if (!meta) throw new McpServerError(`No hosted server "${id}"`, "NOT_FOUND");
    return meta;
  }

  private touch(meta: McpServerMeta, patch: Partial<McpServerMeta> = {}): McpServerMeta {
    const next = { ...meta, ...patch, updatedAt: new Date().toISOString() };
    this.store.saveMeta(next);
    return next;
  }

  // ── reading ──

  list(): Array<ReturnType<McpServerService["summary"]>> {
    return this.store.ids().map((id) => this.summary(id));
  }

  summary(id: string) {
    const meta = this.need(id);
    const draft = this.store.draft(id);
    const production = this.store.production(id);
    const prodSpec = production ? this.store.version(id, production)?.spec : undefined;
    const spec = prodSpec ?? draft?.spec;
    const versions = this.store.versions(id).map((v) => v.version).sort(compareSemver);
    return {
      ...meta,
      name: spec?.name ?? id,
      ...(spec?.description ? { description: spec.description } : {}),
      ...(spec?.icon ? { icon: spec.icon } : {}),
      toolCount: spec?.tools.length ?? 0,
      ...(production ? { production } : {}),
      latest: versions.at(-1),
      versionCount: versions.length,
      draftChanged: !!draft && (!prodSpec || !specsEqual(draft.spec, prodSpec)),
      pendingApprovals: this.store.pending(id).filter((p) => p.status === "pending").length,
    };
  }

  async get(id: string) {
    const meta = this.need(id);
    const draft = this.store.draft(id);
    const production = this.store.production(id);
    const prod = production ? this.store.version(id, production) : undefined;
    const spec = draft?.spec ?? prod?.spec;
    const settingsSpec = prod?.spec ?? draft?.spec;
    const template = meta.template ? serverTemplate(meta.template) : undefined;
    return {
      ...this.summary(id),
      meta,
      // the settings the deployed (else the draft's) spec declares, and the values templates see
      settingsSchema: settingsSpec?.settingsSchema ?? [],
      settings: meta.settings ?? {},
      effectiveSettings: effectiveSettings(settingsSpec?.settingsSchema, meta.settings),
      ...(template ? {
        templateInfo: {
          id: template.id, name: template.name, latestRevision: template.revision, installedRevision: meta.templateRevision ?? (production ? 1 : undefined),
          secrets: template.secrets, docs: template.docs, maturity: template.maturity,
        },
      } : {}),
      draft: draft ? { ...draft, problems: specProblems(draft.spec), ...(draft.baseVersion && production && draft.baseVersion !== production ? { stale: true } : {}) } : null,
      ...(prod ? { productionSpec: prod.spec } : {}),
      secrets: spec ? await secretStatus(this.deps.vault(), spec) : {},
      tests: this.store.tests(id),
      rateLimits: meta.rateLimits ?? DEFAULT_RATE_LIMITS,
    };
  }

  versions(id: string): Array<Omit<McpServerVersion, "spec"> & { toolCount: number; production: boolean }> {
    this.need(id);
    const production = this.store.production(id);
    return this.store.versions(id).sort((a, b) => compareSemver(b.version, a.version))
      .map(({ spec, ...v }) => ({ ...v, toolCount: spec.tools.length, production: v.version === production }));
  }

  version(id: string, version: string): McpServerVersion {
    this.need(id);
    const v = this.store.version(id, version === "production" ? this.store.production(id) ?? "" : version);
    if (!v) throw new McpServerError(`No version ${version} of "${id}"`, "NOT_FOUND");
    return v;
  }

  deploys(id: string): McpServerDeploy[] {
    this.need(id);
    return [...this.store.deploys(id)].reverse();
  }

  /** The spec at a ref: "draft", "production" or a semver. */
  specAt(id: string, ref: string): McpServerSpec | undefined {
    if (ref === "draft") return this.store.draft(id)?.spec;
    if (ref === "production") { const p = this.store.production(id); return p ? this.store.version(id, p)?.spec : undefined; }
    return this.store.version(id, ref)?.spec;
  }

  diff(id: string, from: string | undefined, to: string) {
    this.need(id);
    const toSpec = this.specAt(id, to);
    if (!toSpec) throw new McpServerError(`Nothing at "${to}"`, "NOT_FOUND");
    const fromRef = from ?? (to === "draft" ? "production" : undefined);
    const fromSpec = fromRef ? this.specAt(id, fromRef) : undefined;
    if (from && !fromSpec) throw new McpServerError(`Nothing at "${from}"`, "NOT_FOUND");
    const label = (r: string | undefined) => (r === "production" ? this.store.production(id) ?? "production" : r);
    return {
      server: id, ...(fromRef && fromSpec ? { from: label(fromRef) } : {}), to: label(to)!,
      changes: specChanges(fromSpec, toSpec),
      unified: unifiedSpecDiff(id, { ...(fromSpec ? { label: label(fromRef), spec: fromSpec } : {}) }, { label: label(to)!, spec: toSpec }),
      ...(suggestBump(fromSpec, toSpec) ? { suggestedBump: suggestBump(fromSpec, toSpec) } : {}),
    };
  }

  logs(id: string, limit?: number) {
    this.need(id);
    return this.store.logs(id, limit);
  }

  pending(id: string): PendingCall[] {
    this.need(id);
    return this.store.pending(id);
  }

  // ── writing ──

  create(input: { id?: string; spec: unknown; visibility?: McpServerVisibility; template?: string; templateRevision?: number }, actor: string) {
    const spec = normalizeSpec(input.spec);
    let id = input.id?.trim() || SLUG(spec.name);
    if (!MCP_SERVER_ID_PATTERN.test(id)) throw new McpServerError("id must be lowercase letters, digits and dashes (at most 40)");
    if (this.store.exists(id)) {
      if (input.id) throw new McpServerError(`A hosted server "${id}" already exists`, "CONFLICT");
      let n = 2;
      while (this.store.exists(`${id.slice(0, 37)}-${n}`)) n++;
      id = `${id.slice(0, 37)}-${n}`;
    }
    const now = new Date().toISOString();
    const meta: McpServerMeta = {
      id, createdAt: now, updatedAt: now, createdBy: actor, visibility: input.visibility === "public" ? "public" : "private",
      ...(input.template ? { template: input.template } : {}),
    };
    this.store.saveMeta(meta);
    this.store.saveDraft(id, { spec, updatedAt: now, updatedBy: actor, ...(input.templateRevision ? { templateRevision: input.templateRevision } : {}) });
    this.deps.changed?.(id, "created");
    return { id, problems: specProblems(spec) };
  }

  updateDraft(id: string, input: unknown, actor: string) {
    this.need(id);
    const spec = normalizeSpec(input);
    const current = this.store.draft(id);
    const production = this.store.production(id);
    this.store.saveDraft(id, {
      spec, updatedAt: new Date().toISOString(), updatedBy: actor,
      ...(current?.baseVersion ?? production ? { baseVersion: current?.baseVersion ?? production } : {}),
      ...(current?.templateRevision ? { templateRevision: current.templateRevision } : {}),
    });
    this.touch(this.need(id));
    this.deps.changed?.(id, "draft");
    return { problems: specProblems(spec) };
  }

  /** Throw the draft away: back to the production spec. */
  discardDraft(id: string): void {
    this.need(id);
    const production = this.store.production(id);
    const prod = production ? this.store.version(id, production) : undefined;
    if (!prod) throw new McpServerError("Nothing is deployed: there is nothing to go back to", "CONFLICT");
    this.store.saveDraft(id, { spec: prod.spec, baseVersion: prod.version, updatedAt: new Date().toISOString(), updatedBy: "discard" });
    this.deps.changed?.(id, "draft");
  }

  updateSettings(id: string, patch: { visibility?: unknown; disabled?: unknown; onTestFailure?: unknown; rateLimits?: unknown; settings?: unknown }) {
    const meta = this.need(id);
    const next: Partial<McpServerMeta> = {};
    if (patch.settings !== undefined) {
      // a patch of the values: keys set to null or "" are cleared
      const spec = this.specAt(id, "production") ?? this.store.draft(id)?.spec;
      const merged: Record<string, unknown> = { ...(meta.settings ?? {}) };
      for (const [k, v] of Object.entries((patch.settings ?? {}) as Record<string, unknown>)) { if (v === null || v === "") delete merged[k]; else merged[k] = v; }
      const { values, problems } = validateSettings(spec?.settingsSchema, merged);
      if (problems.length) throw new McpServerError(`Settings: ${problems.join("; ")}`, "INVALID", { problems });
      next.settings = values;
    }
    if (patch.visibility !== undefined) {
      if (patch.visibility !== "private" && patch.visibility !== "public") throw new McpServerError('visibility must be "private" or "public"');
      next.visibility = patch.visibility;
    }
    if (patch.disabled !== undefined) next.disabled = patch.disabled === true;
    if (patch.onTestFailure !== undefined) {
      if (patch.onTestFailure !== "warn" && patch.onTestFailure !== "block") throw new McpServerError('onTestFailure must be "warn" or "block"');
      next.onTestFailure = patch.onTestFailure;
    }
    if (patch.rateLimits !== undefined) {
      const r = patch.rateLimits as Partial<PublicRateLimits> | null;
      const n = (v: unknown, def: number) => (typeof v === "number" && v >= 1 && v <= 100_000 ? Math.floor(v) : def);
      next.rateLimits = r ? { perIpPerMinute: n(r.perIpPerMinute, DEFAULT_RATE_LIMITS.perIpPerMinute), globalPerMinute: n(r.globalPerMinute, DEFAULT_RATE_LIMITS.globalPerMinute) } : undefined;
    }
    const saved = this.touch(meta, next);
    void this.syncConnector(id).catch(() => undefined);
    this.deps.changed?.(id, "settings");
    return saved;
  }

  async remove(id: string): Promise<boolean> {
    const meta = this.store.meta(id);
    if (!meta) return false;
    if (meta.connectorId) {
      const manager = this.deps.connectors?.();
      const connector = manager?.store.get(meta.connectorId);
      if (manager && connector?.transport.type === "hosted" && connector.transport.serverId === id) await manager.remove(meta.connectorId);
    }
    this.store.remove(id);
    this.deps.changed?.(id, "deleted");
    return true;
  }

  saveTests(id: string, tests: unknown): McpServerTestCase[] {
    this.need(id);
    if (!Array.isArray(tests)) throw new McpServerError("tests must be a list");
    const out: McpServerTestCase[] = tests.map((t, i) => {
      const x = t as Record<string, unknown>;
      if (!x || typeof x.tool !== "string" || !x.tool) throw new McpServerError(`tests[${i}].tool is required`);
      const input = x.input && typeof x.input === "object" && !Array.isArray(x.input) ? x.input as Record<string, unknown> : {};
      // the suite's fields (checks, HTTP mocks, mode…) are kept as they are: the suite validates them
      const list = (k: string) => (Array.isArray(x[k]) ? { [k]: x[k] } : {});
      return {
        id: typeof x.id === "string" && /^[\w-]{1,64}$/.test(x.id) ? x.id : randomUUID().slice(0, 8), tool: x.tool, input,
        ...(typeof x.name === "string" && x.name.trim() ? { name: x.name.trim().slice(0, 120) } : {}),
        ...(x.expect === "error" ? { expect: "error" as const } : x.expect === "any" ? { expect: "any" as const } : {}),
        ...(typeof x.contains === "string" && x.contains ? { contains: x.contains } : {}),
        ...list("assertions"), ...list("scorers"), ...list("http"),
        ...(typeof x.mode === "string" ? { mode: x.mode } : {}),
        ...(typeof x.dataset === "string" ? { dataset: x.dataset } : {}),
        ...(typeof x.description === "string" ? { description: x.description } : {}),
        ...(x.skip === true ? { skip: true } : {}),
      } as McpServerTestCase;
    });
    this.store.saveTests(id, out);
    this.deps.changed?.(id, "tests");
    return out;
  }

  // ── the saved tests as a suite (docs/agent-suites.md, "Hosted MCP servers") ──

  /** The server's saved tests and its suite settings. */
  suiteStorage(id: string): { name: string; createdAt: string; tests: McpServerTestCase[]; settings: HostedServerSuiteSettings } {
    const meta = this.need(id);
    const spec = this.specAt(id, "production") ?? this.store.draft(id)?.spec;
    return { name: spec?.name ?? id, createdAt: meta.createdAt, tests: this.store.tests(id), settings: meta.suite ?? {} };
  }

  /** Save the suite's tests (tests.json) and settings (server.json). */
  saveSuiteStorage(id: string, tests: McpServerTestCase[], settings: HostedServerSuiteSettings): void {
    const meta = this.need(id);
    this.store.saveTests(id, tests);
    this.touch(meta, { suite: settings });
    this.deps.changed?.(id, "tests");
  }

  /** Each tool's kind at a ref (http, code), and whether it is destructive / needs approval. */
  toolKinds(id: string, ref: string): Record<string, { kind: "http" | "code"; sensitive: boolean }> | undefined {
    this.need(id);
    const spec = this.specAt(id, ref);
    if (!spec) return undefined;
    return Object.fromEntries(spec.tools.map((t) => [t.name, { kind: t.kind === "code" ? "code" as const : "http" as const, sensitive: isSensitiveTool(t) }]));
  }

  /**
   * One tool call for a suite case. With `mockedHttp` the upstream API is the given `fetch` (the
   * case's HTTP mocks): secrets are placeholders (a real one never reaches a test), DNS is not asked,
   * approval tools run (nothing leaves Polpo). Without it the call is real (read-only tools only).
   */
  async suiteCall(id: string, opts: { ref: string; tool: string; input: Record<string, unknown>; fetch?: FetchLike; mockedHttp: boolean; actor?: string; signal?: AbortSignal }): Promise<TestRunResult> {
    this.need(id);
    const spec = this.specAt(id, opts.ref);
    if (!spec) throw new McpServerError(`Nothing at "${opts.ref}"`, "NOT_FOUND");
    const tool = spec.tools.find((t) => t.name === opts.tool);
    if (!tool) return { ok: false, text: `No tool "${opts.tool}" in ${opts.ref}`, error: `No tool "${opts.tool}" in ${opts.ref}`, ms: 0, tool: opts.tool };
    const version = opts.ref === "draft" ? undefined : opts.ref === "production" ? this.store.production(id) : opts.ref;
    if (!opts.mockedHttp && isSensitiveTool(tool)) {
      return { ok: true, text: "", ms: 0, tool: tool.name, skipped: "destructive / approval tools never run against the real API in a test: mock its HTTP (mode all)" };
    }
    if (tool.kind === "code" && opts.mockedHttp) {
      return { ok: true, text: "", ms: 0, tool: tool.name, skipped: "code tools run in the sandboxed worker with its own network: HTTP mocks do not reach them (run the case in mode none, real HTTP)" };
    }
    if (tool.kind === "code") await this.ensureBuild(id, version ?? "draft", spec);
    const base = this.runtimeDeps();
    const runtime: HostedRuntimeDeps = opts.mockedHttp
      ? {
        ...base,
        vault: placeholderVault(),
        resolve: async () => ["93.184.216.34"],
        sleep: async () => undefined,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      }
      : { ...base, ...(opts.fetch ? { fetch: opts.fetch } : {}) };
    const result = await runTool({
      serverId: id, spec, ...(version ? { version } : {}), toolName: tool.name, input: opts.input, source: "test",
      approved: opts.mockedHttp, ...(opts.actor ? { requestedBy: opts.actor } : {}), ...(opts.signal ? { signal: opts.signal } : {}),
    }, runtime);
    return { ...result, tool: tool.name };
  }

  // ── testing ──

  /**
   * Run one tool (the draft by default) with a sample input. Destructive / approval tools need
   * `confirm: true` to really run; without it they are a dry run (the request that would go out).
   */
  async test(id: string, opts: { tool: string; input?: Record<string, unknown>; ref?: string; confirm?: boolean; dryRun?: boolean; actor?: string }): Promise<TestRunResult> {
    this.need(id);
    const ref = opts.ref ?? "draft";
    const spec = this.specAt(id, ref);
    if (!spec) throw new McpServerError(`Nothing at "${ref}"`, "NOT_FOUND");
    const tool = spec.tools.find((t) => t.name === opts.tool);
    if (!tool) throw new McpServerError(`No tool "${opts.tool}" in ${ref}`, "NOT_FOUND");
    const version = ref === "draft" ? undefined : ref === "production" ? this.store.production(id) : ref;
    if (tool.kind === "code") await this.ensureBuild(id, version ?? "draft", spec);
    const dryRun = opts.dryRun === true || (isSensitiveTool(tool) && opts.confirm !== true);
    const result = await runTool({
      serverId: id, spec, ...(version ? { version } : {}), toolName: tool.name, input: opts.input ?? {}, source: "test",
      approved: true, dryRun, ...(opts.actor ? { requestedBy: opts.actor } : {}),
    }, this.runtimeDeps());
    return {
      ...result, tool: tool.name,
      ...(dryRun && isSensitiveTool(tool) && opts.confirm !== true ? { skipped: "Destructive or approval tool: not sent. Pass confirm: true to really run it." } : {}),
    };
  }

  /** Run the saved tests against a spec. Destructive / approval tools are never run here (skipped). */
  async runSavedTests(id: string, ref = "draft"): Promise<{ results: TestRunResult[]; passed: number; failed: number; skipped: number }> {
    this.need(id);
    const spec = this.specAt(id, ref);
    if (!spec) throw new McpServerError(`Nothing at "${ref}"`, "NOT_FOUND");
    const results: TestRunResult[] = [];
    const version = ref === "draft" ? undefined : ref === "production" ? this.store.production(id) : ref;
    if (spec.tools.some((t) => t.kind === "code")) await this.ensureBuild(id, version ?? "draft", spec);
    for (const test of this.store.tests(id)) {
      const tool = spec.tools.find((t) => t.name === test.tool);
      if (!tool) { results.push({ ok: false, text: "", tool: test.tool, testId: test.id, error: `No tool "${test.tool}"`, ms: 0, passed: false }); continue; }
      if (isSensitiveTool(tool)) { results.push({ ok: true, text: "", tool: tool.name, testId: test.id, ms: 0, skipped: "destructive / approval tools never run automatically" }); continue; }
      const r = await runTool({ serverId: id, spec, ...(version ? { version } : {}), toolName: tool.name, input: test.input, source: "test", approved: true }, this.runtimeDeps());
      const passed = (test.expect === "error" ? !r.ok : test.expect === "any" ? true : r.ok) && (!test.contains || r.text.includes(test.contains) || (r.error ?? "").includes(test.contains));
      results.push({ ...r, tool: tool.name, testId: test.id, passed });
    }
    return {
      results,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.skipped && r.passed === false).length,
      skipped: results.filter((r) => r.skipped).length,
    };
  }

  private async ensureBuild(id: string, versionKey: string, spec: McpServerSpec): Promise<{ lockfile?: string; depsBytes?: number } | undefined> {
    if (!spec.tools.some((t) => t.kind === "code")) return undefined;
    if (!this.deps.build) throw new McpServerError("Code tools cannot be built here", "CONFLICT");
    return this.deps.build({ serverId: id, versionKey, spec, buildDir: this.store.buildDir(id, versionKey) });
  }

  // ── publish / deploy ──

  async publish(id: string, opts: { bump?: McpServerBump; version?: string; note?: string; deploy?: boolean; force?: boolean; testsRun?: { passed: number; failed: number; skipped: number }; override?: { reason: string }; admin?: boolean }, actor: string) {
    const meta = this.need(id);
    const draft = this.store.draft(id);
    if (!draft) throw new McpServerError("There is no draft to publish", "CONFLICT");
    const problems = specProblems(draft.spec);
    if (problems.length) throw new McpServerError(`Fix these first: ${problems.join("; ")}`, "INVALID", { problems });
    const existing = this.store.versions(id);
    const latest = existing.map((v) => v.version).sort(compareSemver).at(-1);
    const latestSpec = latest ? this.store.version(id, latest)?.spec : undefined;
    if (latestSpec && specsEqual(latestSpec, draft.spec)) throw new McpServerError(`The draft is the same as ${latest}: nothing to publish`, "CONFLICT");
    let version: string;
    if (opts.version) {
      if (!/^\d+\.\d+\.\d+$/.test(opts.version)) throw new McpServerError("version must be semver (1.2.0)");
      if (latest && compareSemver(opts.version, latest) <= 0) throw new McpServerError(`version must be greater than ${latest}`, "CONFLICT");
      version = opts.version;
    } else {
      version = nextVersion(existing.map((v) => v.version), opts.bump ?? suggestBump(latestSpec, draft.spec) ?? "patch");
    }
    // saved tests on the draft (destructive / approval tools are skipped)
    // (the install flow ran them just before: not again)
    // the saved tests are the server's suite: run as such (HTTP mocked per case, offline) when the
    // suite runner is wired, else (or when cases need real HTTP) the legacy live run
    const suiteCheck = this.deps.suiteCheck?.();
    const tests = opts.testsRun ?? (this.store.tests(id).length
      ? (suiteCheck ? await suiteCheck(id, "draft", { actor }) : undefined) ?? await this.runSavedTests(id, "draft")
      : undefined);
    if (tests?.failed && (meta.onTestFailure ?? "warn") === "block" && !opts.force) {
      throw new McpServerError(`${tests.failed} saved test(s) failed: publishing is blocked (settings: onTestFailure "block")`, "TESTS_FAILED", { tests });
    }
    const build = await this.ensureBuild(id, version, draft.spec);
    const record: McpServerVersion = {
      version, spec: draft.spec, createdAt: new Date().toISOString(), author: actor,
      ...(opts.note ? { note: opts.note.slice(0, 1000) } : {}), ...(opts.version ? {} : { bump: opts.bump ?? suggestBump(latestSpec, draft.spec) ?? "patch" }),
      changes: specChanges(latestSpec, draft.spec),
      ...(build ? { build: { ...build, builtAt: new Date().toISOString() } } : {}),
      ...(tests ? { tests: { passed: tests.passed, failed: tests.failed, skipped: tests.skipped } } : {}),
    };
    this.store.saveVersion(id, record);
    this.store.saveDraft(id, { ...draft, baseVersion: version });
    if (draft.templateRevision) this.touch(this.need(id), { templateRevision: draft.templateRevision });
    this.deps.changed?.(id, "published");
    // the first version goes live at once (the connector needs something to serve)
    const first = !this.store.production(id);
    let deploy: McpServerDeploy | undefined;
    let deployBlocked: { reason: string; runId?: string; failures: string[] } | undefined;
    if (first || opts.deploy) {
      try {
        deploy = await this.deploy(id, version, { actor, ...(opts.note ? { note: opts.note } : {}), action: first ? "initial" : "deploy", ...(opts.override ? { override: opts.override } : {}), ...(opts.admin ? { admin: true } : {}) });
      } catch (err) {
        // the required suite failed: the version stays published, not deployed
        if (!(err instanceof McpServerError) || err.code !== "GATE_BLOCKED") throw err;
        const d = err.details as { runId?: string; failures?: string[] } | undefined;
        deployBlocked = { reason: err.message, ...(d?.runId ? { runId: d.runId } : {}), failures: d?.failures ?? [] };
      }
    }
    return { version: record.version, changes: record.changes, ...(deploy ? { deployed: deploy } : {}), ...(deployBlocked ? { deployBlocked } : {}), ...(tests ? { tests } : {}) };
  }

  /**
   * Move production to a version. With a required suite (meta.suite.gate.required) the suite runs
   * against the version first and a failure blocks the deploy (GATE_BLOCKED), unless an admin
   * overrides it with a reason (recorded on the deploy). Rollbacks are never gated.
   */
  async deploy(id: string, version: string, opts: { actor: string; note?: string; action?: McpServerDeploy["action"]; override?: { reason: string }; admin?: boolean }): Promise<McpServerDeploy> {
    const meta = this.need(id);
    if (!this.store.version(id, version)) throw new McpServerError(`No version ${version}`, "NOT_FOUND");
    const from = this.store.production(id);
    if (from === version) throw new McpServerError(`${version} is already in production`, "CONFLICT");
    let gate: McpServerDeploy["gate"];
    const gateFn = this.deps.suiteGate?.();
    if (opts.action !== "rollback" && meta.suite?.gate?.required && gateFn) {
      if (opts.override) {
        if (!opts.admin) throw new McpServerError("Only an admin can deploy past the suite gate", "FORBIDDEN");
        const reason = String(opts.override.reason ?? "").trim();
        if (!reason) throw new McpServerError("An override needs a reason");
        gate = { decision: "override", reason: reason.slice(0, 1000), by: opts.actor };
      } else {
        const verdict = await gateFn(id, version, { actor: opts.actor });
        if (!verdict.passed) {
          throw new McpServerError(`Blocked by the suite: ${verdict.failures.join("; ") || "it did not pass"}`, "GATE_BLOCKED", { ...(verdict.runId ? { runId: verdict.runId } : {}), failures: verdict.failures });
        }
        gate = { decision: "pass", ...(verdict.runId ? { runId: verdict.runId } : {}) };
      }
    }
    const entry: McpServerDeploy = {
      id: randomUUID(), ...(from ? { from } : {}), to: version, action: opts.action ?? "deploy", actor: opts.actor,
      ...(opts.note ? { note: opts.note.slice(0, 1000) } : {}), at: new Date().toISOString(), ...(gate ? { gate } : {}),
    };
    this.store.addDeploy(id, entry);
    this.touch(this.need(id));
    await this.syncConnector(id);
    this.deps.changed?.(id, "deployed");
    return entry;
  }

  /** Production back to the version before (or `to`). */
  async rollback(id: string, opts: { actor: string; note?: string; to?: string }): Promise<McpServerDeploy> {
    this.need(id);
    const current = this.store.production(id);
    if (!current) throw new McpServerError("Nothing is deployed", "CONFLICT");
    let target = opts.to;
    if (!target) {
      const history = this.store.deploys(id).map((d) => d.to);
      target = [...history].reverse().find((v) => v !== current);
      if (!target) target = this.store.versions(id).map((v) => v.version).filter((v) => compareSemver(v, current) < 0).sort(compareSemver).at(-1);
    }
    if (!target) throw new McpServerError("There is no earlier version to roll back to", "CONFLICT");
    return this.deploy(id, target, { actor: opts.actor, ...(opts.note ? { note: opts.note } : {}), action: "rollback" });
  }

  // ── secrets (write-only) ──

  /** Save one declared secret's value in the vault entry it references. The value is never returned. */
  async saveSecret(id: string, name: string, value: unknown): Promise<{ name: string; set: true; vault: McpSecretRef }> {
    this.need(id);
    const spec = this.store.draft(id)?.spec ?? this.specAt(id, "production");
    const ref = spec?.secrets[name];
    if (!ref) throw new McpServerError(`"${name}" is not a secret of ${id}`, "NOT_FOUND");
    await this.writeSecret(ref, value);
    this.deps.changed?.(id, "secrets");
    return { name, set: true, vault: ref };
  }

  private async writeSecret(ref: McpSecretRef, value: unknown): Promise<void> {
    const vault = this.deps.vault();
    if (!vault) throw new McpServerError("The vault is not available on this instance (POLPO_VAULT_KEY)", "CONFLICT");
    if (typeof value !== "string" || !value.trim()) throw new McpServerError("The secret value is empty");
    if (value.length > 20_000) throw new McpServerError("The secret value is too long");
    const existing = await vault.get(ref.owner, ref.service).catch(() => undefined);
    // the other fields of the entry stay as they are
    await vault.set(ref.owner, ref.service, {
      ...(existing ?? { type: "api_key" as const }),
      credentials: { ...(existing?.credentials ?? {}), [ref.key]: value.trim() },
    });
  }

  // ── ready-made connectors (templates) ──

  /** Servers made from a template, newest first. */
  private installsOf(templateId: string): McpServerMeta[] {
    return this.store.ids().map((id) => this.store.meta(id)).filter((m): m is McpServerMeta => m?.template === templateId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** The catalog: every template with what it needs and where it stands here (available, installed vX, update available). */
  templates() {
    return MCP_SERVER_TEMPLATES.map((t) => this.templateInfo(t));
  }

  templateInfo(t: McpServerTemplate) {
    const installs = this.installsOf(t.id).map((m) => {
      const production = this.store.production(m.id);
      const revision = m.templateRevision ?? (production ? 1 : undefined);
      const status: TemplateStatus = !production ? "draft" : (revision ?? 1) < t.revision ? "update_available" : "installed";
      return { serverId: m.id, ...(production ? { production } : {}), ...(revision ? { revision } : {}), status, ...(m.connectorId ? { connectorId: m.connectorId } : {}) };
    });
    const order: TemplateStatus[] = ["update_available", "installed", "draft"];
    const status: TemplateStatus = installs.length ? order.find((s) => installs.some((i) => i.status === s))! : "available";
    const tools = t.spec.tools.map((x) => ({
      name: x.name, ...(x.title ? { title: x.title } : {}), description: x.description,
      readOnly: !!x.annotations?.readOnlyHint, requiresApproval: !!x.requiresApproval, destructive: !!x.annotations?.destructiveHint,
    }));
    return {
      id: t.id, name: t.name, vendor: t.vendor, category: t.category, description: t.description, ...(t.icon ? { icon: t.icon } : {}),
      docs: t.docs, setup: t.setup, revision: t.revision, changelog: t.changelog, maturity: t.maturity,
      secrets: Object.entries(t.spec.secrets).map(([name, ref]) => ({ name, vault: ref, ...(t.secrets[name] ?? { label: name, howTo: "" }) })),
      settings: t.spec.settingsSchema ?? [],
      toolCount: tools.length, tools,
      readOnlyTools: tools.filter((x) => x.readOnly).map((x) => x.name),
      approvalTools: tools.filter((x) => x.requiresApproval).map((x) => x.name),
      testCount: t.tests.length,
      status, installs,
    };
  }

  /**
   * Install a template: settings → secrets (saved to the vault when given) → who may use it → the
   * template's read-only tests → publish v1.0.0 and deploy (the connector is created with the chosen
   * agents). Stops early (nothing published) when a secret is missing or a test fails. Installing a
   * template already installed at an older revision makes the new revision the draft, with the diff,
   * for a person to publish; at the same revision it only updates settings and access.
   */
  async install(templateId: string, opts: InstallOptions, actor: string): Promise<InstallResult> {
    const t = serverTemplate(templateId);
    if (!t) throw new McpServerError(`No template "${templateId}"`, "NOT_FOUND");
    const id = opts.id?.trim() || this.installsOf(t.id)[0]?.id || t.id;
    let meta = this.store.meta(id);
    if (meta && meta.template !== t.id) throw new McpServerError(`A server "${id}" already exists and was not made from the ${t.name} template: pass another id`, "CONFLICT");
    if (opts.agents !== undefined && opts.agents !== "*" && (!Array.isArray(opts.agents) || opts.agents.some((a) => typeof a !== "string" || !a.trim()))) {
      throw new McpServerError('agents must be a list of agent names, or "*"');
    }
    const secretValues = opts.secrets ?? {};
    for (const name of Object.keys(secretValues)) if (!t.spec.secrets[name]) throw new McpServerError(`"${name}" is not a secret of the ${t.name} template`);

    // settings: the stored values, then the given ones; checked before anything is written
    const merged: Record<string, unknown> = { ...(meta?.settings ?? {}) };
    for (const [k, v] of Object.entries(opts.settings ?? {})) { if (v === null || v === "") delete merged[k]; else merged[k] = v; }
    const { values: settings, problems } = validateSettings(t.spec.settingsSchema, merged);
    if (problems.length) throw new McpServerError(`Settings: ${problems.join("; ")}`, "INVALID", { problems });

    const production = meta ? this.store.production(id) : undefined;
    const installedRevision = meta ? meta.templateRevision ?? (production ? 1 : undefined) : undefined;
    if (!meta) {
      this.create({ id, spec: t.spec, template: t.id, templateRevision: t.revision }, actor);
      this.store.saveTests(id, t.tests.map((x) => ({ ...x })));
      meta = this.need(id);
    } else if (production && (installedRevision ?? 1) < t.revision) {
      // upgrade: the new revision becomes the draft; the person reviews the diff and publishes
      const draft = this.store.draft(id);
      this.store.saveDraft(id, { spec: t.spec, baseVersion: draft?.baseVersion ?? production, templateRevision: t.revision, updatedAt: new Date().toISOString(), updatedBy: actor });
      const own = this.store.tests(id).filter((x) => !t.tests.some((tt) => tt.id === x.id));
      this.store.saveTests(id, [...t.tests.map((x) => ({ ...x })), ...own]);
      for (const [name, v] of Object.entries(secretValues)) await this.writeSecret(t.spec.secrets[name]!, v);
      const access = await this.applyAccess(id, opts.agents, settings);
      this.deps.changed?.(id, "draft");
      return { id, template: t.id, revision: t.revision, status: "upgrade_draft", diff: this.diff(id, "production", "draft"), settings, ...access };
    } else if (!production) {
      // an install that stopped before publishing: carry on from the template's current revision
      const draft = this.store.draft(id);
      if ((draft?.templateRevision ?? 0) < t.revision) {
        this.store.saveDraft(id, { spec: t.spec, templateRevision: t.revision, updatedAt: new Date().toISOString(), updatedBy: actor });
        const own = this.store.tests(id).filter((x) => !t.tests.some((tt) => tt.id === x.id));
        this.store.saveTests(id, [...t.tests.map((x) => ({ ...x })), ...own]);
      }
    }

    for (const [name, v] of Object.entries(secretValues)) await this.writeSecret(t.spec.secrets[name]!, v);
    const access = await this.applyAccess(id, opts.agents, settings);
    if (production) {
      this.deps.changed?.(id, "settings");
      return { id, template: t.id, revision: t.revision, status: "up_to_date", version: production, settings, ...access };
    }

    const spec = this.store.draft(id)!.spec;
    const status = await secretStatus(this.deps.vault(), spec);
    const missingSecrets = Object.entries(status).filter(([, set]) => !set).map(([name]) => name);
    if (missingSecrets.length) return { id, template: t.id, revision: t.revision, status: "needs_secrets", missingSecrets, settings, ...access };

    const tests = await this.runSavedTests(id, "draft");
    const testsOut = { passed: tests.passed, failed: tests.failed, skipped: tests.skipped, results: tests.results };
    if (tests.failed && !opts.force) return { id, template: t.id, revision: t.revision, status: "tests_failed", tests: testsOut, settings, ...access };
    if (opts.publish === false) return { id, template: t.id, revision: t.revision, status: "draft", tests: testsOut, settings, ...access };

    const published = await this.publish(id, {
      note: `Installed from the ${t.name} template (revision ${t.revision})`, force: true,
      testsRun: { passed: tests.passed, failed: tests.failed, skipped: tests.skipped },
    }, actor);
    const after = await this.applyAccess(id, opts.agents, settings);
    return {
      id, template: t.id, revision: t.revision, status: "installed", version: published.version,
      ...(published.deployed ? { deployed: published.deployed } : {}), tests: testsOut, settings, ...after,
    };
  }

  /** Save the settings and the agents the connector grants (on the connector when it exists). */
  private async applyAccess(id: string, agents: string[] | "*" | undefined, settings: Record<string, string | number | boolean>): Promise<Pick<InstallResult, "connectorId" | "access">> {
    const meta = this.need(id);
    const normalized = agents === undefined ? undefined : agents === "*" ? "*" as const : [...new Set(agents.map((a) => a.trim()))];
    this.touch(meta, { settings, ...(normalized !== undefined ? { installAccess: { agents: normalized } } : {}) });
    const manager = this.deps.connectors?.();
    const connector = meta.connectorId ? manager?.store.get(meta.connectorId) : undefined;
    if (!manager || !connector || connector.transport.type !== "hosted" || connector.transport.serverId !== id) {
      return normalized !== undefined ? { access: { agents: normalized, polpo: true } } : {};
    }
    if (normalized !== undefined) {
      manager.store.update(connector.id, { access: { ...connector.access, agents: normalized } });
      manager.announce(connector.id, "updated");
    }
    const now = manager.store.get(connector.id)!;
    return { connectorId: connector.id, access: { agents: now.access.agents, polpo: !!now.access.polpo } };
  }

  // ── the connector ──

  /**
   * Create or update the connector bound to the server: transport "hosted", the instance's own
   * access rules (Polpo by default, agents granted in Connectors), the deployed version as label.
   */
  async syncConnector(id: string): Promise<ConnectorConfig | undefined> {
    const manager = this.deps.connectors?.();
    if (!manager) return undefined;
    const meta = this.need(id);
    const production = this.store.production(id);
    const spec = production ? this.store.version(id, production)?.spec : undefined;
    if (!spec || !production) return undefined;
    const existing = meta.connectorId ? manager.store.get(meta.connectorId) : undefined;
    const bound = existing?.transport.type === "hosted" && existing.transport.serverId === id ? existing : undefined;
    // the spec's icon key (a bundled official mark), else its template's (servers made before the template had one)
    const iconKey = spec.icon && /^[a-z0-9]+$/.test(spec.icon) ? spec.icon
      : meta.template && Object.hasOwn(HOSTED_SERVER_ICON_FILES, meta.template) ? meta.template : undefined;
    const icon = iconKey ? { simpleIcons: iconKey } : undefined;
    if (bound) {
      manager.store.update(bound.id, {
        name: spec.name, ...(spec.description ? { description: spec.description } : {}), hostedVersion: production,
        ...(icon ? { icon } : {}),
      });
      await manager.close(bound.id);
      manager.announce(bound.id, "updated");
      return manager.store.get(bound.id);
    }
    let connectorId = CONNECTOR_ID_PATTERN.test(id) && !manager.store.get(id) ? id : `${id.slice(0, 33)}-hosted`;
    let n = 2;
    while (manager.store.get(connectorId)) connectorId = `${id.slice(0, 33)}-h${n++}`;
    const connector: ConnectorConfig = {
      id: connectorId, name: spec.name, kind: "mcp", ...(spec.description ? { description: spec.description } : {}),
      transport: { type: "hosted", serverId: id }, auth: { type: "none" },
      // like any connector: Polpo may use it, agents are granted explicitly in Connectors
      access: { agents: meta.installAccess?.agents ?? [], polpo: true }, enabled: true,
      ...(icon ? { icon } : {}), hostedVersion: production, createdAt: new Date().toISOString(), status: "disconnected",
    };
    manager.store.create(connector);
    this.touch(meta, { connectorId });
    manager.announce(connectorId, "created");
    return connector;
  }

  // ── approvals ──

  /** Run an approved call once (in the server process), or mark it rejected. */
  async resolvePending(serverId: string, callId: string, decision: "approved" | "rejected", by?: string): Promise<PendingCall | undefined> {
    const call = this.store.pendingCall(serverId, callId);
    if (!call || call.status !== "pending") return call;
    const at = new Date().toISOString();
    if (decision === "rejected") {
      const next: PendingCall = { ...call, status: "rejected", resolvedAt: at, ...(by ? { resolvedBy: by } : {}) };
      this.store.savePending(next);
      this.deps.changed?.(serverId, "pending");
      return next;
    }
    this.store.savePending({ ...call, status: "approved", resolvedAt: at, ...(by ? { resolvedBy: by } : {}) });
    const spec = (call.version ? this.store.version(serverId, call.version)?.spec : undefined) ?? this.specAt(serverId, "production");
    const result = spec
      ? await runTool({ serverId, spec, ...(call.version ? { version: call.version } : {}), toolName: call.tool, input: call.input, source: "approval", approved: true, ...(call.approvalId ? { approvalId: call.approvalId } : {}) }, this.runtimeDeps())
      : { ok: false, text: "The server has no deployed version any more", error: "The server has no deployed version any more", ms: 0 };
    const next: PendingCall = {
      ...call, status: result.ok ? "done" : "failed", resolvedAt: at, ...(by ? { resolvedBy: by } : {}),
      result: { ok: result.ok, text: result.text.slice(0, 4000), ...(result.error ? { error: result.error } : {}) },
    };
    this.store.savePending(next);
    this.deps.changed?.(serverId, "pending");
    return next;
  }

  /** Every pending call, across servers. */
  allPending(): PendingCall[] {
    return this.store.ids().flatMap((id) => this.store.pending(id));
  }

  /** Find the pending call an approval request is about. */
  findByApproval(approvalId: string): PendingCall | undefined {
    return this.allPending().find((p) => p.approvalId === approvalId);
  }
}

export { McpServerInputError };
