/**
 * Daytona v2 (providers.daytona.api = "v2"): Linux VMs through @daytona/sdk 2.x (aliased
 * @daytona/sdk-v2), with the SDKs mocked (no network, no credentials).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DAYTONA_V2_HIBERNATE_DEFAULTS, DAYTONA_V2_MAX_TIMEOUT_SECONDS, DAYTONA_V2_RUNNER_IMAGE, daytonaApiVersion, daytonaProviderErrors, daytonaV2HibernateSettings,
  type ComputerConfig, type EffectiveSandbox, type SandboxNetwork,
} from "@polpo-ai/core/sandbox";

// ── mocked SDKs ─────────────────────────────────────────────────────────

interface FakeSb {
  id: string; state: string; sandboxClass?: string; labels: Record<string, string>;
  lifecyclePolicy?: { timeoutSeconds?: number; timeoutAt?: string };
  network?: { blockAll: boolean; allowDomains?: string[]; allowCidrs?: string[] } | undefined;
}

const v2 = vi.hoisted(() => ({
  ctor: [] as any[],
  creates: [] as Array<{ image: string; opts: any }>,
  sandboxes: new Map<string, any>(),
  calls: [] as string[],
  execs: [] as Array<{ command: any; opts: any }>,
  execResult: undefined as any,
  createError: undefined as any,
  searchError: undefined as any,
  createClass: "linux",
  createdState: "started",
  networkUpdates: [] as Array<{ policy: any; ifMatch: string }>,
  networkResets: [] as string[],
  lifecycleUpdates: [] as any[],
  n: 0,
  // memory and disk snapshots (createSnapshot / createFromSnapshot), as seen live
  snapshots: new Map<string, { id: string; name: string; status: string; sandboxId: string; reads: number; createdAt: string; error?: string }>(),
  snapReadyAfter: 2,
  snapFail: undefined as string | undefined,
  snapCreateError: undefined as any,
  restores: [] as Array<{ snapshot: string; opts: any }>,
  restoreError: undefined as any,
  sn: 0,
  clock: Date.parse("2026-11-21T10:00:00Z"),
  // as seen live: the label search still lists a VM deleted seconds ago as started, and a read by
  // id answers "destroyed" (not 404); a delete of a destroyed VM is refused
  staleSearch: false,
  destroyedVisible: false,
  createFailures: 0,
  processStarts: [] as Array<{ command: any; opts: any }>,
}));
const v0 = vi.hoisted(() => ({ created: [] as any[] }));
const providerOptions = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

function fakeSandbox(s: FakeSb) {
  const sb: any = {
    get id() { return s.id; },
    get state() { return s.state; },
    get sandboxClass() { return s.sandboxClass; },
    get rawSandboxClass() { return s.sandboxClass; },
    get labels() { return s.labels; },
    get lifecyclePolicy() { return s.lifecyclePolicy; },
    wait: async () => { s.state = "started"; return sb; },
    start: async () => { v2.calls.push(`start ${s.id} from ${s.state}`); s.state = "started"; },
    // live: a Linux v2 sandbox is not persistent
    stop: async () => { v2.calls.push(`stop ${s.id}`); throw notPersistent(); },
    pause: async () => { v2.calls.push(`pause ${s.id}`); throw notPersistent(); },
    fork: async () => { v2.calls.push(`fork ${s.id}`); throw notPersistent(); },
    createSnapshot: async (name: string) => {
      v2.calls.push(`snapshot ${s.id} ${name}`);
      if (v2.snapCreateError) throw v2.snapCreateError;
      const snap = { id: `snap_${++v2.sn}`, name, status: "building", sandboxId: s.id, reads: 0, createdAt: new Date(v2.clock).toISOString() };
      v2.snapshots.set(snap.id, snap);
      return snapView(snap);
    },
    resume: async () => { v2.calls.push(`resume ${s.id}`); s.state = "started"; },
    delete: async () => { v2.calls.push(`delete ${s.id}`); s.state = "destroyed"; },
    refreshData: async () => undefined,
    resetIdleTimer: async () => { v2.calls.push(`idle-reset ${s.id}`); return {}; },
    updateLifecyclePolicy: async (p: any) => { v2.lifecycleUpdates.push(p); return {}; },
    exec: async (command: any, opts: any) => {
      v2.execs.push({ command, opts });
      return v2.execResult ?? { processId: "p1", reason: "exited", exitCode: 0, stdout: "out\n", stderr: "err\n", output: "out\nerr\n", logs: [] };
    },
    // background processes (agent harness bridges): a log stream, then the exit
    process: {
      start: async (command: any, opts: any) => {
        v2.calls.push(`process.start ${s.id} ${JSON.stringify(command)}`);
        v2.processStarts.push({ command, opts });
        return fakeProcess(`proc_${v2.processStarts.length}`, s);
      },
      connect: (id: string) => { v2.calls.push(`process.connect ${s.id} ${id}`); return fakeProcess(id, s); },
    },
    ports: {
      previewLink: async (port: number) => { v2.calls.push(`previewLink ${s.id} ${port}`); return { url: `https://${port}-${s.id}.proxy.example`, token: `tok-${s.id}`, expiresAt: "2026-11-21T11:00:00Z" }; },
      signedPreviewLink: async (port: number, o: any) => { v2.calls.push(`signedPreviewLink ${s.id} ${port} ${o?.expiresInSeconds}`); return { url: `https://${port}-signed-${s.id}.proxy.example`, token: "t", expiresAt: "2026-11-22T10:00:00Z" }; },
    },
    fs: {
      readBytes: async (path: string) => new TextEncoder().encode(`content of ${path}`),
      writeBytes: async (path: string, data: Uint8Array) => { v2.calls.push(`write ${path} ${data.byteLength}`); },
    },
    getNetworkPolicy: async () => ({ etag: `"etag-${s.id}"`, desiredRevision: 1, desired: s.network ? { version: 1, allowCidrs: [], ...s.network } : undefined }),
    updateNetworkPolicy: async (policy: any, o: { ifMatch: string }) => { v2.networkUpdates.push({ policy, ifMatch: o.ifMatch }); s.network = { blockAll: !!policy.blockAll, allowDomains: policy.allowDomains, allowCidrs: policy.allowCidrs }; return {}; },
    resetNetworkPolicy: async (o: { ifMatch: string }) => { v2.networkResets.push(o.ifMatch); s.network = undefined; return {}; },
  };
  return sb;
}

/** A started process: two log frames (stdout, stderr), eof, exit 0 — or exit lost when its VM is gone. */
function fakeProcess(id: string, s: FakeSb) {
  return {
    id,
    streamLogs: async function* () {
      yield { type: "log", frame: { cursor: "1", channel: "stdout", data: "bridge ready\n" } };
      yield { type: "log", frame: { cursor: "2", channel: "stderr", data: "warn\n" } };
      yield { type: "eof", cursor: "3" };
    },
    wait: async () => {
      await new Promise((r) => setTimeout(r, 10)); // the process runs a moment
      if (s.state === "destroyed") throw Object.assign(new Error("502 BAD_GATEWAY"), { statusCode: 502 });
      return { reason: "exited", exitCode: 0 };
    },
    kill: async (o: any) => { v2.calls.push(`process.kill ${id} ${o?.signal}`); },
  };
}

function notPersistent() {
  return Object.assign(new Error("sandbox is not persistent"), { statusCode: 409, code: "CONFLICT" });
}

function snapView(x: { id: string; name: string; status: string; sandboxId: string; createdAt: string; error?: string }) {
  return { id: x.id, name: x.name, status: x.status, sandboxId: x.sandboxId, createdAt: x.createdAt, ...(x.error ? { error: x.error } : {}), ...(x.status === "ready" ? { bytes: 1_500_000_000, memoryBytes: 224_000_000 } : {}) };
}

/** A read of a building snapshot: ready after snapReadyAfter reads; failed when its source went first (as seen live) or snapFail says so. */
function readSnapshot(id: string) {
  const x = v2.snapshots.get(id);
  if (!x) throw Object.assign(new Error(`snapshot ${id} not found`), { statusCode: 404, code: "NOT_FOUND" });
  if (x.status === "building") {
    x.reads++;
    const source = v2.sandboxes.get(x.sandboxId);
    if (!source || source.s.state === "destroyed") { x.status = "failed"; x.error = "source sandbox deleted before the snapshot was ready"; }
    else if (v2.snapFail) { x.status = v2.snapFail; x.error = "capture failed"; }
    else if (x.reads >= v2.snapReadyAfter) x.status = "ready";
  }
  return snapView(x);
}

function addSandbox(s: Partial<FakeSb> & { id: string }) {
  const full: FakeSb = { state: "started", sandboxClass: "linux", labels: {}, ...s };
  v2.sandboxes.set(full.id, { s: full, sb: fakeSandbox(full) });
  return full;
}

vi.mock("@daytona/sdk-v2", () => ({
  Daytona: class {
    constructor(opts: unknown) { v2.ctor.push(opts); }
    get v2() {
      return {
        create: async (image: string, opts: any) => {
          if (v2.createError) throw v2.createError;
          if (v2.createFailures > 0) { v2.createFailures--; throw Object.assign(new Error("name is still taken by a sandbox being destroyed"), { statusCode: 409 }); }
          v2.creates.push({ image, opts });
          const id = `sbx_${++v2.n}`;
          const timeoutAt = opts.lifecyclePolicy?.timeoutSeconds ? new Date(v2.clock + opts.lifecyclePolicy.timeoutSeconds * 1000).toISOString() : undefined;
          const s = addSandbox({ id, state: v2.createdState, sandboxClass: v2.createClass, labels: { ...opts.labels, ...(opts.name ? { name: opts.name } : {}) }, network: opts.networkPolicy, lifecyclePolicy: { timeoutSeconds: opts.lifecyclePolicy?.timeoutSeconds, timeoutAt } });
          return v2.sandboxes.get(s.id).sb;
        },
        // a VM from a ready snapshot: started, its files and processes back; no network policy option
        createFromSnapshot: async (snapshot: string, opts: any) => {
          v2.calls.push(`restore ${snapshot}`);
          if (v2.restoreError) throw v2.restoreError;
          const x = v2.snapshots.get(snapshot);
          if (!x) throw Object.assign(new Error(`snapshot ${snapshot} not found`), { statusCode: 404, code: "NOT_FOUND" });
          if (x.status !== "ready") throw Object.assign(new Error(`snapshot ${snapshot} is ${x.status}`), { statusCode: 400 });
          v2.restores.push({ snapshot, opts });
          const id = `sbx_${++v2.n}`;
          const timeoutAt = new Date(v2.clock + opts.lifecyclePolicy.timeoutSeconds * 1000).toISOString();
          const s = addSandbox({ id, labels: { ...opts.labels, ...(opts.name ? { name: opts.name } : {}) }, lifecyclePolicy: { timeoutSeconds: opts.lifecyclePolicy.timeoutSeconds, timeoutAt } });
          return v2.sandboxes.get(s.id).sb;
        },
        snapshots: {
          get: async (id: string) => readSnapshot(id),
          iter: async function* () { for (const x of v2.snapshots.values()) yield snapView(x); },
          delete: async (id: string) => {
            v2.calls.push(`delete-snapshot ${id}`);
            if (!v2.snapshots.delete(id)) throw Object.assign(new Error("not found"), { statusCode: 404, code: "NOT_FOUND" });
          },
        },
        get: async (id: string) => {
          const e = v2.sandboxes.get(id);
          if (e && e.s.state === "destroyed" && v2.destroyedVisible) return e.sb;
          if (!e || e.s.state === "destroyed") throw Object.assign(new Error(`sandbox ${id} not found`), { statusCode: 404, code: "NOT_FOUND" });
          return e.sb;
        },
        search: async (opts: any) => {
          if (v2.searchError) throw v2.searchError;
          v2.calls.push(`search ${JSON.stringify(opts.labels)}`);
          const lagging = (e: any) => (v2.staleSearch && e.s.state === "destroyed" ? Object.create(e.sb, { state: { value: "started" } }) : e.sb);
          const items = [...v2.sandboxes.values()].filter((e) => (opts.states.includes(e.s.state) || (v2.staleSearch && e.s.state === "destroyed")) && Object.entries(opts.labels ?? {}).every(([k, v]) => e.s.labels[k] === v)).map(lagging);
          return { items, total: items.length, totalRelation: "eq", rawTotalRelation: "eq" };
        },
        iter: async function* () { for (const e of v2.sandboxes.values()) yield e.sb; },
        delete: async (id: string) => {
          const e = v2.sandboxes.get(id);
          if (!e) throw Object.assign(new Error("not found"), { statusCode: 404 });
          if (e.s.state === "destroyed" && v2.destroyedVisible) throw Object.assign(new Error(`sandbox ${id} is destroyed`), { statusCode: 400, code: "BAD_REQUEST" });
          await e.sb.delete();
        },
      };
    }
  },
}));

vi.mock("@daytona/sdk", () => ({
  Daytona: class {
    async create(params: any) {
      v0.created.push(params);
      return { id: "dt-v0", state: "started", sandboxClass: "container", process: { executeCommand: async () => ({ exitCode: 0, result: "v0" }) }, fs: {}, delete: async () => undefined };
    }
    async get() { return { id: "dt-v0", state: "started", pause: async () => undefined }; }
    snapshot = { get: async (name: string) => ({ name, state: "inactive" }) };
  },
}));

vi.mock("../sandbox/remote-providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sandbox/remote-providers.js")>()),
  remoteProviderCredentials: async (id: string) => {
    const o = providerOptions.value;
    return { apiKey: `key-${id}`, ...(o.api === "v2" ? { api: "v2" } : {}), ...(typeof o.image === "string" ? { image: o.image } : {}), ...(typeof o.region === "string" ? { region: o.region } : {}), ...(typeof o.maxTimeoutSeconds === "number" ? { maxTimeoutSeconds: o.maxTimeoutSeconds } : {}),
      ...(o.hibernate ? { hibernate: { keepSnapshots: 1, safetySnapshotHours: 6, rotateBeforeMinutes: 60, rotateIdleGapSeconds: 90, forceRotateMinutes: 10, snapshotTimeoutSeconds: 300, retryMinutes: 10, ...(o.hibernate as object) } } : {}) };
  },
}));

vi.mock("../sandbox/tailnet-egress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sandbox/tailnet-egress.js")>()),
  onComputerStarted: vi.fn(),
}));

const { remoteAdapter, resetRemoteAdapters, SandboxNetworkConfigError } = await import("../sandbox/remote-adapters.js");
const { daytonaV2NetworkPolicy, daytonaV2Resources, daytonaV2Lifecycle, DAYTONA_V2_COMPUTER_TIMEOUT_SECONDS } = await import("../sandbox/daytona-v2.js");
const { ComputerManager, computerMachineName, computerSnapshotName, isComputerSnapshotName } = await import("../sandbox/computers.js");
const { onComputerStarted } = await import("../sandbox/tailnet-egress.js");
const { poolKey } = await import("../sandbox/pool.js");

const allow = (...hosts: string[]): SandboxNetwork => ({ mode: "allowlist", allow: hosts });
function sandbox(over: Partial<EffectiveSandbox> = {}): EffectiveSandbox {
  return { provider: "daytona", network: { mode: "open" }, resources: {}, providerOptions: { ...providerOptions.value }, denied: [], ...over };
}
const spec = (sb: EffectiveSandbox, over: Record<string, unknown> = {}) => ({ sandbox: sb, labels: { polpo: "1" }, lifetimeMinutes: 20, keep: false, ...over });

const dirs: string[] = [];
beforeEach(() => {
  Object.assign(v2, {
    ctor: [], creates: [], calls: [], execs: [], execResult: undefined, createError: undefined, searchError: undefined,
    createClass: "linux", createdState: "started", networkUpdates: [], networkResets: [], lifecycleUpdates: [], n: 0,
    snapReadyAfter: 2, snapFail: undefined, snapCreateError: undefined, restores: [], restoreError: undefined, sn: 0,
    clock: Date.parse("2026-11-21T10:00:00Z"), staleSearch: false, destroyedVisible: false, createFailures: 0, processStarts: [],
  });
  v2.sandboxes.clear();
  v2.snapshots.clear();
  vi.mocked(onComputerStarted).mockClear();
  v0.created.length = 0;
  providerOptions.value = { api: "v2" };
  resetRemoteAdapters();
});
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// ── settings ────────────────────────────────────────────────────────────

describe("providers.daytona.api", () => {
  test("defaults to v0; only \"v2\" selects the new service", () => {
    expect(daytonaApiVersion(undefined)).toBe("v0");
    expect(daytonaApiVersion({ snapshot: "polpo-runner-0.3.13" })).toBe("v0");
    expect(daytonaApiVersion({ api: "v2" })).toBe("v2");
  });

  test("validation: unknown version, an API URL with v2, a class other than linux-vm", () => {
    expect(daytonaProviderErrors(undefined)).toEqual([]);
    expect(daytonaProviderErrors({ apiUrl: "https://app.daytona.io/api", target: "us", snapshot: "polpo-runner-0.3.13" })).toEqual([]);
    expect(daytonaProviderErrors({ api: "v2", image: "polpo-runner-vm-1", region: "eu", target: "us" })).toEqual([]);
    expect(daytonaProviderErrors({ api: "v3" })[0]).toMatch(/api must be "v0".*or "v2"/);
    expect(daytonaProviderErrors({ api: "v2", apiUrl: "https://app.daytona.io/api" })[0]).toMatch(/Daytona v2 only talks to Daytona Cloud.*takes no API URL/);
    expect(daytonaProviderErrors({ api: "v2", class: "container" })[0]).toMatch(/always Linux VMs \("linux-vm"\)/);
    expect(daytonaProviderErrors({ api: "v2", class: "linux-vm" })).toEqual([]);
    expect(daytonaProviderErrors({ image: 3 })[0]).toMatch(/image must be a string/);
    expect(daytonaProviderErrors({ api: "v2", maxTimeoutSeconds: 43_200 })).toEqual([]);
    expect(daytonaProviderErrors({ api: "v2", maxTimeoutSeconds: 10 })[0]).toMatch(/maxTimeoutSeconds must be a whole number of seconds, at least 60/);
    expect(daytonaProviderErrors({ api: "v2", hibernate: { keepSnapshots: 2, safetySnapshotHours: 0, rotateBeforeMinutes: 30 } })).toEqual([]);
    expect(daytonaProviderErrors({ api: "v2", hibernate: { keepSnapshots: 0 } })[0]).toMatch(/hibernate\.keepSnapshots must be a whole number from 1 to 10/);
    expect(daytonaProviderErrors({ api: "v2", hibernate: { keep: 2 } })[0]).toMatch(/hibernate\.keep is not a hibernate setting/);
    expect(daytonaProviderErrors({ api: "v2", hibernate: 3 })[0]).toMatch(/hibernate must be an object/);
  });

  test("hibernate settings: defaults, bounds, forced rotation inside the rotation window", () => {
    expect(daytonaV2HibernateSettings(undefined)).toEqual(DAYTONA_V2_HIBERNATE_DEFAULTS);
    expect(DAYTONA_V2_HIBERNATE_DEFAULTS).toMatchObject({ keepSnapshots: 1, safetySnapshotHours: 6, rotateBeforeMinutes: 60, snapshotTimeoutSeconds: 300 });
    expect(daytonaV2HibernateSettings({ hibernate: { keepSnapshots: 3, safetySnapshotHours: 99 } })).toMatchObject({ keepSnapshots: 3, safetySnapshotHours: 6 });
    expect(daytonaV2HibernateSettings({ hibernate: { rotateBeforeMinutes: 10, forceRotateMinutes: 20 } })).toMatchObject({ rotateBeforeMinutes: 10, forceRotateMinutes: 5 });
  });

  test("loading polpo.json refuses v2 with an API URL; v0 settings load as before", async () => {
    const { parseConfig } = await import("../core/config.js");
    const workDir = mkdtempSync(join(tmpdir(), "polpo-daytona-v2-config-"));
    dirs.push(workDir);
    mkdirSync(join(workDir, ".polpo"));
    const write = (daytona: unknown) => writeFileSync(join(workDir, ".polpo", "polpo.json"), JSON.stringify({ project: "p", settings: { sandbox: { providers: { daytona } } } }));
    write({ apiUrl: "https://app.daytona.io/api", target: "us", snapshot: "polpo-runner-0.3.13" });
    expect((await parseConfig(workDir)).settings.sandbox?.providers?.daytona).toMatchObject({ snapshot: "polpo-runner-0.3.13" });
    write({ api: "v2", apiUrl: "https://app.daytona.io/api" });
    await expect(parseConfig(workDir)).rejects.toThrow(/takes no API URL/);
    write({ api: "v2" });
    expect((await parseConfig(workDir)).settings.sandbox?.providers?.daytona).toEqual({ api: "v2" });
  });

  test("PATCH /config/settings refuses invalid Daytona settings before saving; v2 without a URL is saved", async () => {
    const { configRoutes } = await import("@polpo-ai/server");
    let config: any = { project: "p", teams: [], settings: { maxRetries: 2 } };
    const app = configRoutes(() => ({ getConfig: () => config, reloadConfig: async () => true, saveConfig: async (c: any) => { config = c; }, getNotificationRouter: () => null } as any));
    const patch = (sandbox: unknown) => app.request("/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sandbox }) });
    const bad = await patch({ providers: { daytona: { api: "v2", apiUrl: "https://app.daytona.io/api" } } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/takes no API URL/);
    expect((await patch({ providers: { daytona: { api: "v9" } } })).status).toBe(400);
    expect(config.settings.sandbox).toBeUndefined();
    expect((await patch({ providers: { daytona: { api: "v2", image: "polpo-runner-vm-1" } } })).status).toBe(200);
    expect(config.settings.sandbox.providers.daytona).toEqual({ api: "v2", image: "polpo-runner-vm-1" });
  });

  test("Settings → Sandbox status: API version, VM class and image; v2 credentials carry no v0 URL or region", async () => {
    const real = await vi.importActual<typeof import("../sandbox/remote-providers.js")>("../sandbox/remote-providers.js");
    const store = { get: async () => ({ type: "api_key", credentials: { apiKey: "dtn_project" } }) } as any;
    const credential = { owner: "ops", service: "daytona" };
    real.configureRemoteProviders(store, () => ({ daytona: { credential, api: "v2", apiUrl: "https://app.daytona.io/api", target: "us", region: "eu" } }));
    const [d] = await real.remoteProviderStatus();
    expect(d).toMatchObject({ id: "daytona", api: "v2", vmClass: "linux-vm", effectiveImage: DAYTONA_V2_RUNNER_IMAGE, region: "eu" });
    const creds = await real.remoteProviderCredentials("daytona");
    expect(creds).toMatchObject({ apiKey: "dtn_project", api: "v2", region: "eu" });
    expect(creds!.apiUrl).toBeUndefined();
    expect(creds!.target).toBeUndefined();
    real.configureRemoteProviders(store, () => ({ daytona: { credential, snapshot: "polpo-runner-0.3.13" } }));
    const [v0Status] = await real.remoteProviderStatus();
    expect(v0Status).toMatchObject({ api: "v0", snapshot: "polpo-runner-0.3.13" });
    expect(v0Status.vmClass).toBeUndefined();
    real.configureRemoteProviders(undefined, () => undefined);
  });

  test("the build script's v2 image is the default Polpo creates from", async () => {
    // @ts-expect-error plain .mjs script
    const script = await import("../../scripts/build-sandbox-images.mjs");
    expect(script.DAYTONA_V2_IMAGE).toBe(DAYTONA_V2_RUNNER_IMAGE);
    // pnpm for agent harness bootstraps: the image bakes the version the engine activates otherwise
    const { HARNESS_PNPM_VERSION } = await import("../adapters/harness-engine.js");
    expect(script.PNPM_VERSION).toBe(HARNESS_PNPM_VERSION);
    expect(script.ROOT_STEPS.some((x: string) => x.includes(`corepack prepare pnpm@${HARNESS_PNPM_VERSION} --activate`))).toBe(true);
  });

  test("the default runner image not built in the project yet: the previous one, with a warning", async () => {
    let first = true;
    const realCreate = v2.createError;
    v2.createError = undefined;
    const warnings: string[] = [];
    const { Daytona } = await import("@daytona/sdk-v2") as any;
    const proto = Object.getOwnPropertyDescriptor(Daytona.prototype, "v2")!.get!;
    const spy = vi.spyOn(Daytona.prototype, "v2", "get").mockImplementation(function (this: any) {
      const client = proto.call(this);
      return { ...client, create: async (image: string, opts: any) => {
        if (first && image === DAYTONA_V2_RUNNER_IMAGE) { first = false; throw Object.assign(new Error("image not found"), { code: "IMAGE_NOT_FOUND" }); }
        return client.create(image, opts);
      } };
    });
    try {
      await remoteAdapter("daytona").create(spec(sandbox(), { onWarning: (m: string) => warnings.push(m) }));
      expect(v2.creates.at(-1)!.image).toBe("polpo-runner-vm-2");
      expect(warnings[0]).toMatch(/not built in this project yet: using "polpo-runner-vm-2"/);
    } finally {
      spy.mockRestore();
      v2.createError = realCreate;
    }
  });

  test("the build script builds the v2 image once, named, from the same steps (mocked client)", async () => {
    // @ts-expect-error plain .mjs script
    const script = await import("../../scripts/build-sandbox-images.mjs");
    const builds: any[] = [];
    let image: any;
    const fake = {
      images: {
        get: async (ref: string) => { if (!image || (ref !== image.id && ref !== image.name)) throw new Error("not found"); return image; },
        build: async (builder: any, opts: any) => { builds.push({ dockerfile: builder.toDockerfile(), opts }); image = { id: "img_1", name: opts.name, status: "ready", sandboxClass: "linux" }; return image; },
        delete: async () => { image = undefined; },
      },
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await script.buildDaytonaV2({}, false, fake)).toBe(DAYTONA_V2_RUNNER_IMAGE);
      expect(builds).toHaveLength(1);
      expect(builds[0].opts).toEqual({ name: DAYTONA_V2_RUNNER_IMAGE });
      expect(builds[0].dockerfile).toMatch(/FROM node:22-bookworm-slim/);
      expect(builds[0].dockerfile).toMatch(/agent-browser install/);
      await script.buildDaytonaV2({}, false, fake);
      expect(builds).toHaveLength(1); // already there: left alone
    } finally {
      log.mockRestore();
    }
  });
});

// ── mapping ─────────────────────────────────────────────────────────────

describe("v2 network policy", () => {
  test("deny and an empty allowlist block everything; open and unrestricted set no policy", () => {
    expect(daytonaV2NetworkPolicy({ mode: "deny" })).toEqual({ blockAll: true });
    expect(daytonaV2NetworkPolicy(allow())).toEqual({ blockAll: true });
    expect(daytonaV2NetworkPolicy({ mode: "open" })).toBeUndefined();
    expect(daytonaV2NetworkPolicy({ mode: "unrestricted" })).toBeUndefined();
  });

  test("host names and addresses together (v0 refused the mix); ports dropped; wildcards kept", () => {
    expect(daytonaV2NetworkPolicy(allow("*.github.com", "registry.npmjs.org:443", "10.0.0.0/8", "1.2.3.4", "2001:db8::1"))).toEqual({
      blockAll: true, allowDomains: ["*.github.com", "registry.npmjs.org"], allowCidrs: ["10.0.0.0/8", "1.2.3.4/32", "2001:db8::1/128"],
    });
  });

  test("an entry that is neither a host nor an address is an error before anything is created", async () => {
    expect(() => daytonaV2NetworkPolicy(allow("https://x.com/path"))).toThrow(SandboxNetworkConfigError);
    await expect(remoteAdapter("daytona").create(spec(sandbox({ network: allow("https://x.com/path") })))).rejects.toThrow(SandboxNetworkConfigError);
    expect(v2.creates).toHaveLength(0);
  });
});

describe("v2 sizing and lifecycle", () => {
  test("resources become the VM's limits (cores of 2 vCPUs, GiB); defaults match the v0 runner", () => {
    expect(daytonaV2Resources({ resources: {} })).toEqual({ cpuMax: 1, memoryMax: 4, diskMax: 10 });
    expect(daytonaV2Resources({ resources: { cpus: 4, memoryMb: 8192, diskMb: 20_000 } })).toEqual({ cpuMax: 2, memoryMax: 8, diskMax: 20 });
    expect(daytonaV2Resources({ resources: { cpus: 3 } }).cpuMax).toBe(1.5);
  });

  test("one run: deleted after its lifetime; pooled: deleted later; every wall clock capped at the plan's maximum", () => {
    expect(daytonaV2Lifecycle({ lifetimeMinutes: 20, keep: false })).toEqual({ timeoutSeconds: 1200, onTimeout: "delete", idleExpirySeconds: 1200, onIdleTimeout: "delete" });
    expect(daytonaV2Lifecycle({ lifetimeMinutes: 20, keep: true, deleteAfterStopMinutes: 30 })).toEqual({ timeoutSeconds: 3000, onTimeout: "delete", idleExpirySeconds: -1 });
    const computer = daytonaV2Lifecycle({ lifetimeMinutes: 15, keep: true, persistent: { idleStopMinutes: 15 } });
    expect(DAYTONA_V2_COMPUTER_TIMEOUT_SECONDS).toBe(86_400);
    // a computer: the plan's wall clock (at most 24 h) deletes its VM; it is rotated through a snapshot before
    expect(computer).toEqual({ timeoutSeconds: DAYTONA_V2_MAX_TIMEOUT_SECONDS, onTimeout: "delete", idleExpirySeconds: -1 });
    expect(daytonaV2Lifecycle({ lifetimeMinutes: 15, keep: true, persistent: { idleStopMinutes: 15 } }, 200_000).timeoutSeconds).toBe(86_400);
    expect(daytonaV2Lifecycle({ lifetimeMinutes: 15, keep: true, persistent: { idleStopMinutes: 15 } }, 3600).timeoutSeconds).toBe(3600);
    // the cap: 86400 s by default (the plan's maximum), providers.daytona.maxTimeoutSeconds otherwise
    expect(daytonaV2Lifecycle({ lifetimeMinutes: 2000, keep: false }).timeoutSeconds).toBe(86_400);
    expect(daytonaV2Lifecycle({ lifetimeMinutes: 2000, keep: true, deleteAfterStopMinutes: 60 }, 3600).timeoutSeconds).toBe(3600);
    expect(daytonaV2Lifecycle({ lifetimeMinutes: 120, keep: false }, 3600)).toEqual({ timeoutSeconds: 3600, onTimeout: "delete", idleExpirySeconds: 3600, onIdleTimeout: "delete" });
    // Linux VMs accept only "delete" as a policy action: never "pause" or "stop"
    for (const p of [computer, daytonaV2Lifecycle({ lifetimeMinutes: 20, keep: true }), daytonaV2Lifecycle({ lifetimeMinutes: 20, keep: false })]) {
      expect([p.onTimeout, p.onIdleTimeout].filter((a) => a && a !== "delete")).toEqual([]);
    }
  });
});

// ── adapter ─────────────────────────────────────────────────────────────

describe("Daytona v2 adapter", () => {
  test("create: a Linux VM from the runner image, with labels, size, lifecycle and network policy; project key only", async () => {
    const driver = await remoteAdapter("daytona").create(spec(sandbox({ network: allow("*.github.com") }), { keep: true, deleteAfterStopMinutes: 30 }));
    expect(driver.remoteId).toBe("sbx_1");
    expect(v2.ctor).toEqual([{ apiKey: "key-daytona" }]); // no apiUrl, no target
    expect(v2.creates).toHaveLength(1);
    const { image, opts } = v2.creates[0];
    expect(image).toBe(DAYTONA_V2_RUNNER_IMAGE);
    expect(opts).toMatchObject({
      labels: { polpo: "1" },
      resources: { cpuMax: 1, memoryMax: 4, diskMax: 10 },
      lifecyclePolicy: { onTimeout: "delete", idleExpirySeconds: -1 },
      networkPolicy: { blockAll: true, allowDomains: ["*.github.com"] },
    });
    expect(opts.name).toBeUndefined();
    expect(v0.created).toHaveLength(0);
  });

  test("the image and region come from the settings (instance or computer)", async () => {
    providerOptions.value = { api: "v2", image: "team-image", region: "eu" };
    await remoteAdapter("daytona").create(spec(sandbox()));
    expect(v2.creates[0].image).toBe("team-image");
    expect(v2.creates[0].opts.region).toBe("eu");
    await remoteAdapter("daytona").create(spec(sandbox({ providerOptions: { api: "v2", image: "computer-image" } })));
    expect(v2.creates[1].image).toBe("computer-image");
  });

  test("a missing image says how to build it", async () => {
    v2.createError = Object.assign(new Error("image polpo-runner-vm-1 not found"), { statusCode: 404, code: "IMAGE_NOT_FOUND" });
    await expect(remoteAdapter("daytona").create(spec(sandbox()))).rejects.toThrow(/build-sandbox-images\.mjs --provider daytona-v2/);
  });

  test("a create whose wait ended early waits for started; a non-Linux class is reported", async () => {
    v2.createdState = "starting";
    v2.createClass = "macos";
    const warnings: string[] = [];
    await remoteAdapter("daytona").create(spec(sandbox(), { onWarning: (m: string) => warnings.push(m) }));
    expect(v2.sandboxes.get("sbx_1").s.state).toBe("started");
    expect(warnings[0]).toMatch(/not a Linux VM/);
  });

  test("exec: bash -c as argv, stdout and stderr apart, exit code, timeout and signals", async () => {
    const driver = await remoteAdapter("daytona").create(spec(sandbox()));
    const r = await driver.exec("echo out; echo err >&2", { cwd: "/work", env: { A: "1" }, timeoutMs: 2500 });
    expect(r).toEqual({ exitCode: 0, stdout: "out\n", stderr: "err\n" });
    expect(v2.execs[0]).toEqual({ command: { argv: ["bash", "-c", "echo out; echo err >&2"] }, opts: { cwd: "/work", env: { A: "1" }, timeoutSeconds: 3, executionTimeoutSeconds: 3 } });

    v2.execResult = { reason: "exited", exitCode: 3, stdout: "", stderr: "boom", output: "boom", logs: [], processId: "p" };
    expect(await driver.exec("false", {})).toEqual({ exitCode: 3, stdout: "", stderr: "boom" });
    expect(v2.execs[1].opts).toEqual({});

    v2.execResult = { reason: "timed_out", stdout: "partial", stderr: "", output: "partial", logs: [], processId: "p" };
    expect(await driver.exec("sleep 99", { timeoutMs: 1000 })).toMatchObject({ exitCode: 124, stdout: "partial", timedOut: true });

    v2.execResult = { reason: "signaled", signal: "KILL", stdout: "", stderr: "", output: "", logs: [], processId: "p" };
    expect((await driver.exec("x", {})).exitCode).toBe(137);
  });

  test("files go through the v2 filesystem", async () => {
    const driver = await remoteAdapter("daytona").create(spec(sandbox()));
    expect(new TextDecoder().decode(await driver.readFile("/a.txt"))).toBe("content of /a.txt");
    await driver.writeFile("/b.txt", new Uint8Array([1, 2, 3]));
    expect(v2.calls).toContain("write /b.txt 3");
  });

  test("never pauses or stops (not persistent): suspend is a no-op; the reaper's idle stop deletes a pooled VM; keepAlive pushes the idle timer", async () => {
    const driver = await remoteAdapter("daytona").create(spec(sandbox()));
    await driver.suspend();
    await driver.resume();
    await driver.keepAlive!(60_000);
    expect(v2.calls).toContain("idle-reset sbx_1");
    await remoteAdapter("daytona").suspendById("sbx_1");
    expect(v2.calls).toContain("delete sbx_1");
    // a VM already gone: nothing to do
    await remoteAdapter("daytona").suspendById("sbx_1");
    // a computer's machine is never deleted by an idle stop: it hibernates through the ComputerManager
    addSandbox({ id: "sbx_pc", labels: { "polpo-computer": "i:nina" } });
    await expect(remoteAdapter("daytona").suspendById("sbx_pc")).rejects.toThrow(/hibernates .* instead of pausing/);
    expect(v2.calls.some((c) => c.startsWith("pause") || c.startsWith("stop") || c === "delete sbx_pc")).toBe(false);
  });

  test("hibernation (as seen live): pause/stop/fork answer 409; a snapshot builds then is ready; deleting its source first fails it", async () => {
    const driver = await remoteAdapter("daytona").create(spec(sandbox()));
    const raw = v2.sandboxes.get("sbx_1").sb;
    for (const op of ["pause", "stop", "fork"]) await expect(raw[op]()).rejects.toMatchObject({ statusCode: 409 });
    const h = (await remoteAdapter("daytona").hibernation!())!;
    expect(h.settings).toEqual(DAYTONA_V2_HIBERNATE_DEFAULTS);
    const snap = await h.snapshot(driver.remoteId, "polpo-computer-i-nina-20261121100000000");
    expect(snap).toMatchObject({ id: "snap_1", status: "building", sandboxId: "sbx_1" });
    expect((await h.getSnapshot("snap_1"))!.status).toBe("building");
    expect(await h.getSnapshot("snap_1")).toMatchObject({ status: "ready", memoryBytes: 224_000_000, bytes: 1_500_000_000 });
    expect(await h.machine("sbx_1")).toMatchObject({ state: "started" });
    // the source deleted before the snapshot is ready: the snapshot fails
    await h.snapshot(driver.remoteId, "polpo-computer-i-nina-20261121100000001");
    await remoteAdapter("daytona").remove("sbx_1");
    expect(await h.getSnapshot("snap_2")).toMatchObject({ status: "failed" });
    expect(await h.machine("sbx_1")).toBeUndefined();
    expect((await h.listSnapshots((n) => n.endsWith("000"))).map((x) => x.id)).toEqual(["snap_1"]);
    await h.deleteSnapshot("snap_1");
    await h.deleteSnapshot("snap_1"); // already gone: fine
    expect(await h.getSnapshot("snap_1")).toBeUndefined();
    // v0 has no hibernation
    providerOptions.value = {};
    expect(await remoteAdapter("daytona").hibernation!()).toBeUndefined();
  });

  test("create caps the wall clock at providers.daytona.maxTimeoutSeconds", async () => {
    providerOptions.value = { api: "v2", maxTimeoutSeconds: 7200 };
    await remoteAdapter("daytona").create(spec(sandbox(), { lifetimeMinutes: 600, keep: false }));
    expect(v2.creates[0].opts.lifecyclePolicy).toMatchObject({ timeoutSeconds: 7200, onTimeout: "delete" });
  });

  test("connect resumes a paused VM, re-arms a running one's wall clock when it runs low, refuses a deleted one", async () => {
    addSandbox({ id: "sbx_p", state: "paused" });
    await remoteAdapter("daytona").connect("sbx_p");
    expect(v2.calls).toContain("start sbx_p from paused");

    addSandbox({ id: "sbx_low", lifecyclePolicy: { timeoutSeconds: 3600, timeoutAt: new Date(Date.now() + 60_000).toISOString() } });
    addSandbox({ id: "sbx_ok", lifecyclePolicy: { timeoutSeconds: 3600, timeoutAt: new Date(Date.now() + 3500_000).toISOString() } });
    await remoteAdapter("daytona").connect("sbx_low");
    await remoteAdapter("daytona").connect("sbx_ok");
    expect(v2.lifecycleUpdates).toEqual([{ timeoutSeconds: 3600 }]);

    addSandbox({ id: "sbx_gone", state: "destroyed" });
    await expect(remoteAdapter("daytona").connect("sbx_gone")).rejects.toThrow(/not found/);
  });

  test("list finds VMs by label (search), skipping deleted ones; falls back to walking every VM without search", async () => {
    addSandbox({ id: "a", labels: { polpo: "1", "polpo-instance": "i1" } });
    addSandbox({ id: "b", labels: { polpo: "1", "polpo-instance": "i2" } });
    addSandbox({ id: "c", state: "destroyed", labels: { polpo: "1", "polpo-instance": "i1" } });
    expect((await remoteAdapter("daytona").list({ "polpo-instance": "i1" })).map((v) => v.remoteId)).toEqual(["a"]);
    v2.searchError = Object.assign(new Error("search not configured"), { statusCode: 501, code: "SEARCH_NOT_CONFIGURED" });
    expect((await remoteAdapter("daytona").list({ "polpo-instance": "i2" })).map((v) => v.remoteId)).toEqual(["b"]);
    v2.searchError = Object.assign(new Error("boom"), { statusCode: 500 });
    await expect(remoteAdapter("daytona").list({ polpo: "1" })).rejects.toThrow("boom");
  });

  test("remove deletes; a VM already gone (or one of the v0 service) is not an error", async () => {
    addSandbox({ id: "x" });
    await remoteAdapter("daytona").remove("x");
    expect(v2.calls).toContain("delete x");
    await expect(remoteAdapter("daytona").remove("dt-v0-id")).resolves.toBeUndefined();
  });

  test("the network rule changes while the VM exists: full replacement with the ETag; unchanged rules are not rewritten", async () => {
    addSandbox({ id: "n", network: { blockAll: true, allowDomains: ["a.com"] } });
    expect(await remoteAdapter("daytona").updateNetwork!("n", allow("a.com"))).toBe(false);
    expect(await remoteAdapter("daytona").updateNetwork!("n", allow("a.com", "b.com"))).toBe(true);
    expect(v2.networkUpdates).toEqual([{ policy: { blockAll: true, allowDomains: ["a.com", "b.com"] }, ifMatch: "\"etag-n\"" }]);
    expect(await remoteAdapter("daytona").updateNetwork!("n", { mode: "open" })).toBe(true);
    expect(v2.networkResets).toEqual(["\"etag-n\""]);
  });

  test("v2 has no v0 snapshots to report", async () => {
    expect(await remoteAdapter("daytona").snapshotState!("polpo-runner-0.3.13")).toBeUndefined();
  });
});

// ── v0 unaffected ───────────────────────────────────────────────────────

describe("v0 stays as it was", () => {
  test("without api (or api v0) Daytona creates through the 0.x SDK with the snapshot", async () => {
    providerOptions.value = { snapshot: "polpo-runner-0.3.13" };
    const driver = await remoteAdapter("daytona").create(spec(sandbox()));
    expect(driver.remoteId).toBe("dt-v0");
    expect(v0.created[0]).toMatchObject({ snapshot: "polpo-runner-0.3.13", ephemeral: true, autoStopInterval: 20 });
    expect(v0.created[0].name).toBeUndefined();
    expect(v2.creates).toHaveLength(0);
    expect(await remoteAdapter("daytona").snapshotState!("polpo-runner-0.3.13")).toBe("inactive");
    expect(await remoteAdapter("daytona").updateNetwork!("dt-v0", allow("a.com"))).toBe(false);
  });

  test("switching api while the server runs takes effect on the next call", async () => {
    providerOptions.value = {};
    await remoteAdapter("daytona").create(spec(sandbox()));
    providerOptions.value = { api: "v2" };
    await remoteAdapter("daytona").create(spec(sandbox()));
    expect(v0.created).toHaveLength(1);
    expect(v2.creates).toHaveLength(1);
  });

  test("pool keys: v0 keys unchanged, v2 keys apart (a v0 VM is never reused under v2)", () => {
    const v0Sandbox = sandbox({ providerOptions: { snapshot: "polpo-runner-0.3.13" } });
    const v2Sandbox = sandbox({ providerOptions: { snapshot: "polpo-runner-0.3.13", api: "v2" } });
    expect(poolKey("daytona", v0Sandbox)).toBe(poolKey("daytona", sandbox({ providerOptions: { snapshot: "polpo-runner-0.3.13" } })));
    expect(poolKey("daytona", v2Sandbox)).not.toBe(poolKey("daytona", v0Sandbox));
    expect(poolKey("daytona", sandbox({ providerOptions: { api: "v2" } }))).toBe(poolKey("daytona", sandbox({ providerOptions: { api: "v2", image: DAYTONA_V2_RUNNER_IMAGE } })));
  });
});

// ── computers on v2: hibernate ──────────────────────────────────────────

describe("computers on Daytona v2: hibernate (memory and disk snapshots)", () => {
  const nina: ComputerConfig = { id: "nina", name: "Nina", kind: "daytona", lifecycle: { idleStopMinutes: 15 }, network: allow("example.com") };
  const sb = (c: ComputerConfig = nina) => sandbox({ network: c.network ?? { mode: "open" }, computer: c });
  const setup = (opts: { hold?: () => Promise<void> } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "polpo-daytona-v2-computer-"));
    dirs.push(dir);
    const m = new ComputerManager(dir, {
      now: () => v2.clock,
      // the snapshot polls advance the clock (no real waits)
      sleep: async (ms) => { v2.clock += ms; await opts.hold?.(); },
    });
    const notices: string[] = [];
    m.onNotice = (_id, level, message) => notices.push(`${level}: ${message}`);
    const changes: any[] = [];
    m.onChange = (_id, live) => changes.push(live);
    // in use now: lastUsedAt written (touch writes in the background)
    const use = async () => {
      m.touch(nina, undefined, true);
      const at = new Date(v2.clock).toISOString();
      await vi.waitFor(() => expect(m.read().nina?.lastUsedAt).toBe(at));
    };
    return { m, notices, changes, use, advance: (ms: number) => { v2.clock += ms; } };
  };
  const running = () => [...v2.sandboxes.values()].filter((e) => e.s.state === "started").map((e) => e.s.id);
  const idx = (call: string) => v2.calls.indexOf(call);
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  test("allowed on v2: polpo.json loads, POST /computers creates, switching settings to v2 keeps Daytona computers", async () => {
    const { parseConfig } = await import("../core/config.js");
    const workDir = mkdtempSync(join(tmpdir(), "polpo-daytona-v2-config-"));
    dirs.push(workDir);
    mkdirSync(join(workDir, ".polpo"), { recursive: true });
    writeFileSync(join(workDir, ".polpo", "polpo.json"), JSON.stringify({ project: "p", settings: { sandbox: { providers: { daytona: { api: "v2" } } }, computers: [{ id: "nina", name: "Nina", kind: "daytona" }] } }));
    expect((await parseConfig(workDir)).settings.computers?.[0]?.id).toBe("nina");

    const { computerRoutes } = await import("../server/routes/computers.js");
    const state = { computers: [] as ComputerConfig[] };
    const routes = computerRoutes({
      computers: () => state.computers, settings: () => ({ sandbox: { providers: { daytona: { api: "v2" } } } }) as any, agents: async () => [],
      manager: () => setup().m, save: async (list) => { state.computers = list; }, sandboxFor: () => ({ error: "no key" }), emit: () => {},
    });
    const res = await routes.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "nina", kind: "daytona" }) });
    expect(res.status).toBe(201);

    const { configRoutes } = await import("@polpo-ai/server");
    let config: any = { project: "p", teams: [], settings: { computers: [{ id: "nina", name: "Nina", kind: "daytona" }] } };
    const app = configRoutes(() => ({ getConfig: () => config, reloadConfig: async () => true, saveConfig: async (c: any) => { config = c; }, getNotificationRouter: () => null } as any));
    const patch = await app.request("/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sandbox: { providers: { daytona: { api: "v2", hibernate: { keepSnapshots: 2 } } } } }) });
    expect(patch.status).toBe(200);
    expect(config.settings.sandbox.providers.daytona).toEqual({ api: "v2", hibernate: { keepSnapshots: 2 } });
  });

  test("first use: a Linux VM from the image with its stable name and labels, a fresh create key, a 24 h wall clock that deletes", async () => {
    const { m } = setup();
    await m.ensure(nina, sb());
    expect(v2.creates).toHaveLength(1);
    const { opts } = v2.creates[0];
    expect(opts.name).toBe(computerMachineName(m.labelValue("nina")));
    expect(opts.labels["polpo-computer"]).toBe(m.labelValue("nina"));
    expect(opts.idempotencyKey).toBe(`${opts.name}:${v2.clock}`);
    expect(opts.lifecyclePolicy).toEqual({ timeoutSeconds: 86_400, onTimeout: "delete", idleExpirySeconds: -1 });
    expect(m.live("nina").status).toBe("running");
    expect(m.read().nina.timeoutAt).toBe(new Date(v2.clock + 86_400_000).toISOString());
  });

  test("snapshot names belong to one computer of one instance", () => {
    const at = Date.parse("2026-11-21T22:18:55.123Z");
    expect(computerSnapshotName("inst:nina", at)).toBe("polpo-computer-inst-nina-20261121221855123");
    expect(isComputerSnapshotName("inst:nina", "polpo-computer-inst-nina-20261121221855123")).toBe(true);
    expect(isComputerSnapshotName("inst:nina", computerSnapshotName("inst:nina-2", at))).toBe(false);
    expect(isComputerSnapshotName("inst:nina", computerSnapshotName("other:nina", at))).toBe(false);
    expect(isComputerSnapshotName("inst:nina", "polpo-computer-inst-nina-latest")).toBe(false);
  });

  test("idle → hibernated: a snapshot, ready, then the VM deleted (never paused or stopped); the card shows the snapshot", async () => {
    const { m, advance, changes } = setup();
    await m.ensure(nina, sb());
    advance(16 * MIN);
    await m.idleTick([nina]);
    const snapCall = v2.calls.find((c) => c.startsWith("snapshot sbx_1 "))!;
    expect(snapCall).toMatch(new RegExp(`^snapshot sbx_1 ${computerMachineName(m.labelValue("nina"))}-\\d{17}$`));
    expect(v2.snapshots.get("snap_1")!.status).toBe("ready");
    expect(idx("delete sbx_1")).toBeGreaterThan(idx(snapCall)); // only once the snapshot was ready (deleting first would fail it)
    expect(v2.calls.some((c) => /^(pause|stop|fork) /.test(c))).toBe(false);
    expect(running()).toEqual([]);
    const live = m.live("nina");
    expect(live).toMatchObject({ status: "hibernated", lastSnapshot: { diskBytes: 1_500_000_000, memoryBytes: 224_000_000 } });
    expect(live.remoteId).toBeUndefined();
    expect(changes.map((x) => x.status)).toEqual(["creating", "running", "stopping", "hibernated"]);
    // nothing more to do while it hibernates
    await m.idleTick([nina]);
    expect(v2.calls.filter((c) => c.startsWith("snapshot"))).toHaveLength(1);
  });

  test("a snapshot that fails keeps the VM running (error shown, retried later); the failed snapshot is deleted", async () => {
    providerOptions.value = { api: "v2", hibernate: { retryMinutes: 30 } };
    const { m, advance, notices } = setup();
    await m.ensure(nina, sb());
    v2.snapFail = "failed";
    await expect(m.stop(nina)).rejects.toThrow(/Could not hibernate \(stop\): the snapshot failed: capture failed\. It keeps running; tried again in 30 min/);
    expect(running()).toEqual(["sbx_1"]);
    expect(v2.calls).not.toContain("delete sbx_1");
    expect(v2.snapshots.size).toBe(0);
    expect(m.live("nina")).toMatchObject({ status: "running", remoteId: "sbx_1", lastError: expect.stringMatching(/keeps running/) });
    expect(m.read().nina.snapshots ?? []).toEqual([]);

    // idle, but within the retry delay: left running
    v2.snapFail = undefined;
    advance(16 * MIN);
    await m.idleTick([nina]);
    expect(v2.calls.filter((c) => c.startsWith("snapshot"))).toHaveLength(1);
    expect(running()).toEqual(["sbx_1"]);
    // the delay is over: hibernated
    advance(15 * MIN);
    await m.idleTick([nina]);
    expect(v2.calls.filter((c) => c.startsWith("snapshot"))).toHaveLength(2);
    expect(m.live("nina").status).toBe("hibernated");
    expect(notices).toEqual([]);

    // a snapshot that never gets ready: given up after snapshotTimeoutSeconds, the VM kept
    await m.ensure(nina, sb());
    v2.snapReadyAfter = 100_000;
    await expect(m.stop(nina)).rejects.toThrow(/not ready after 300 s/);
    expect(m.live("nina").status).toBe("running");
  });

  test("snapshots unavailable on the plan: the API's error is surfaced, nothing deleted", async () => {
    const { m } = setup();
    await m.ensure(nina, sb());
    v2.snapCreateError = Object.assign(new Error("FEATURE_NOT_ENABLED: snapshots are not enabled for this organization"), { statusCode: 403 });
    await expect(m.stop(nina)).rejects.toThrow(/Could not hibernate \(stop\): FEATURE_NOT_ENABLED: snapshots are not enabled/);
    expect(running()).toEqual(["sbx_1"]);
    expect(m.live("nina").lastError).toMatch(/FEATURE_NOT_ENABLED/);
  });

  test("wake: the next use makes a VM from the snapshot (name, labels, 24 h wall clock), re-applies the network rule, checks the tailnet, then deletes older snapshots", async () => {
    const { m } = setup();
    await m.ensure(nina, sb());
    expect(onComputerStarted).toHaveBeenCalledTimes(1);
    await m.stop(nina);
    const driver = await m.ensure(nina, sb());
    expect(driver.remoteId).toBe("sbx_2");
    expect(v2.creates).toHaveLength(1); // not from the image again
    const { snapshot, opts } = v2.restores[0];
    expect(snapshot).toBe("snap_1");
    expect(opts).toMatchObject({ name: computerMachineName(m.labelValue("nina")), labels: m.labels("nina"), lifecyclePolicy: { timeoutSeconds: 86_400, onTimeout: "delete", idleExpirySeconds: -1 } });
    expect(opts.idempotencyKey).toMatch(/:wake:snap_1:\d+$/);
    expect(v2.networkUpdates.at(-1)).toEqual({ policy: { blockAll: true, allowDomains: ["example.com"] }, ifMatch: "\"etag-sbx_2\"" });
    // the tailnet is checked again on the new VM (its daemons came back with the memory)
    expect(onComputerStarted).toHaveBeenCalledTimes(2);
    expect(vi.mocked(onComputerStarted).mock.calls[1]![0]).toMatchObject({ id: "nina" });
    expect(m.live("nina")).toMatchObject({ status: "running", remoteId: "sbx_2" });
    expect(m.read().nina.restoredFrom).toBe("snap_1");
    expect([...v2.snapshots.keys()]).toEqual(["snap_1"]); // keepSnapshots 1: the one it runs from

    // second cycle: snap_1 goes once snap_2 is ready and the VM is deleted (keepSnapshots 1 while
    // hibernated too: live, nina kept 2 snapshots between a hibernation and the next wake)
    await m.stop(nina);
    expect(idx("delete-snapshot snap_1")).toBeGreaterThan(idx("delete sbx_2"));
    expect([...v2.snapshots.keys()]).toEqual(["snap_2"]);
    expect(m.read().nina.restoredFrom).toBeUndefined();
    expect(m.read().nina.snapshots!.map((x) => x.id)).toEqual(["snap_2"]);
    await m.start(nina, sb());
    expect(v2.restores.at(-1)!.snapshot).toBe("snap_2");
    expect([...v2.snapshots.keys()]).toEqual(["snap_2"]);
  });

  test("keepSnapshots 2: a hibernated computer keeps its two newest snapshots", async () => {
    providerOptions.value = { api: "v2", hibernate: { keepSnapshots: 2 } };
    const { m } = setup();
    await m.ensure(nina, sb());
    for (let i = 0; i < 3; i++) { await m.stop(nina); await m.ensure(nina, sb()); }
    await m.stop(nina);
    expect([...v2.snapshots.keys()]).toEqual(["snap_3", "snap_4"]);
  });

  test("a failed wake keeps every snapshot; the next use tries again", async () => {
    const { m } = setup();
    await m.ensure(nina, sb());
    await m.stop(nina);
    await m.ensure(nina, sb());
    await m.stop(nina);
    const deletes = v2.calls.filter((c) => c.startsWith("delete-snapshot")).length;
    v2.restoreError = Object.assign(new Error("no capacity"), { statusCode: 503 });
    await expect(m.ensure(nina, sb())).rejects.toThrow(/no capacity/);
    expect(m.live("nina").status).toBe("error");
    expect([...v2.snapshots.keys()]).toEqual(["snap_2"]);
    expect(v2.calls.filter((c) => c.startsWith("delete-snapshot"))).toHaveLength(deletes); // the failed wake deleted none
    v2.restoreError = undefined;
    await m.ensure(nina, sb());
    expect(v2.restores.at(-1)!.snapshot).toBe("snap_2");
    expect([...v2.snapshots.keys()]).toEqual(["snap_2"]);
  });

  test("the snapshot is gone: an older one, else a fresh VM from the image, with a notice", async () => {
    const { m, notices } = setup();
    await m.ensure(nina, sb());
    await m.stop(nina);
    v2.snapshots.delete("snap_1");
    await m.ensure(nina, sb());
    expect(v2.creates).toHaveLength(2);
    expect(v2.restores).toHaveLength(0);
    expect(m.live("nina").notice).toMatch(/a new VM from the image \(its files are lost\)/);
    expect(notices.at(-1)).toMatch(/^warn: .*new VM from the image/);
  });

  test("the state file lost: it wakes from its newest snapshot, found by its name", async () => {
    const { m } = setup();
    await m.ensure(nina, sb());
    await m.stop(nina);
    rmSync(join(m.polpoDir, "computers-state.json"));
    await m.ensure(nina, sb());
    expect(v2.restores.map((r) => r.snapshot)).toEqual(["snap_1"]);
    expect(v2.creates).toHaveLength(1);
  });

  test("24 h wall clock: rotated at a quiet gap (snapshot, new VM from it); busy → waits; close to the end → forced, with a warning", async () => {
    const { m, advance, notices, use } = setup();
    await m.ensure(nina, sb());
    const sandboxFor = () => sb();
    // busy (used 30 s ago) 50 min before the end: not yet
    advance(23 * HOUR + 9 * MIN + 30_000);
    await use();
    advance(30_000);
    await m.idleTick([nina], sandboxFor);
    expect(v2.calls.some((c) => c.startsWith("snapshot"))).toBe(false);
    // a quiet gap of 2 min: rotated
    advance(2 * MIN);
    await m.idleTick([nina], sandboxFor);
    expect(v2.calls.filter((c) => c.startsWith("snapshot"))).toHaveLength(1);
    expect(v2.calls).toContain("delete sbx_1");
    expect(v2.restores.map((r) => r.snapshot)).toEqual(["snap_1"]);
    expect(m.live("nina")).toMatchObject({ status: "running", remoteId: "sbx_2" });
    expect(m.read().nina.timeoutAt).toBe(new Date(v2.clock + 86_400_000).toISOString());
    expect(notices.at(-1)).toBe("info: Rotated through a snapshot before its VM's wall clock");

    // busy all along: forced once less than 10 min are left
    advance(23 * HOUR + 51 * MIN);
    await use();
    advance(10_000);
    await m.idleTick([nina], sandboxFor);
    expect(v2.restores).toHaveLength(2);
    expect(m.live("nina")).toMatchObject({ status: "running", remoteId: "sbx_3", notice: expect.stringMatching(/while it was busy/) });
    expect(notices.at(-1)).toMatch(/^warn: Rotated .* while it was busy: a pause of a few seconds/);
  });

  test("safety snapshots every 6 h while it runs (the VM keeps running); older ones are pruned", async () => {
    const { m, advance, use } = setup();
    await m.ensure(nina, sb());
    advance(5 * HOUR);
    await use();
    await m.idleTick([nina]);
    expect(v2.calls.some((c) => c.startsWith("snapshot"))).toBe(false);
    advance(HOUR);
    await use();
    await m.idleTick([nina]);
    expect(v2.snapshots.get("snap_1")!.status).toBe("ready");
    expect(running()).toEqual(["sbx_1"]);
    expect(m.live("nina")).toMatchObject({ status: "running", remoteId: "sbx_1", lastSnapshot: { at: expect.any(String) } });
    advance(6 * HOUR);
    await use();
    await m.idleTick([nina]);
    expect([...v2.snapshots.keys()]).toEqual(["snap_2"]);
    expect(running()).toEqual(["sbx_1"]);
  });

  test("a VM that vanished is restored from the last snapshot, with a notice (computer:changed)", async () => {
    const { m, advance, changes, use } = setup();
    await m.ensure(nina, sb());
    advance(6 * HOUR);
    await use();
    await m.idleTick([nina]); // safety snapshot snap_1
    v2.sandboxes.get("sbx_1").s.state = "destroyed"; // the wall clock or the provider
    // a refresh sees it: hibernated, with a notice
    const seen = await m.refresh(nina);
    expect(seen).toMatchObject({ status: "hibernated", notice: expect.stringMatching(/Its VM is gone .* restores it from the snapshot of/) });
    expect(changes.at(-1)).toMatchObject({ status: "hibernated", notice: expect.stringMatching(/VM is gone/) });
    await m.ensure(nina, sb());
    expect(v2.restores.map((r) => r.snapshot)).toEqual(["snap_1"]);
    expect(m.live("nina")).toMatchObject({ status: "running", remoteId: "sbx_2", notice: expect.stringMatching(/Its VM was gone .* restored from the snapshot of .* changes made after it are lost/) });

    // straight to the next use, without a refresh: the same
    v2.sandboxes.get("sbx_2").s.state = "destroyed";
    await m.ensure(nina, sb());
    expect(v2.restores.map((r) => r.snapshot)).toEqual(["snap_1", "snap_1"]);
    expect(m.live("nina").notice).toMatch(/Its VM was gone/);
  });

  test("commands that arrive while it hibernates wait, then run on the woken VM", async () => {
    let release!: () => void;
    let held: Promise<void> | undefined;
    const { m } = setup({ hold: () => held ?? Promise.resolve() });
    const driver = await m.attach(nina, sb());
    const execOn = () => v2.execs.length;
    held = new Promise((r) => { release = r; });
    const stopping = m.stop(nina);
    await vi.waitFor(() => expect(v2.calls.some((c) => c.startsWith("snapshot sbx_1"))).toBe(true));
    const exec = driver.exec("echo hi", {});
    await new Promise((r) => setTimeout(r, 20));
    expect(execOn()).toBe(0); // waiting for the hibernation
    held = undefined;
    release();
    await stopping;
    const r = await exec;
    expect(r.exitCode).toBe(0);
    expect(execOn()).toBe(1);
    expect(idx("restore snap_1")).toBeGreaterThan(idx("delete sbx_1"));
    expect(driver.remoteId).toBe("sbx_2");
    expect(m.live("nina")).toMatchObject({ status: "running", remoteId: "sbx_2" });
  });

  test("hibernation waits for a running command (this process)", async () => {
    let finish!: () => void;
    // the drain's waits are real here (a few ms each), so the command can finish meanwhile
    const { m } = setup({ hold: () => new Promise((r) => setTimeout(r, 1)) });
    const driver = await m.attach(nina, sb());
    v2.execResult = undefined;
    const slow = new Promise<void>((r) => { finish = r; });
    const realExec = v2.sandboxes.get("sbx_1").sb.exec;
    v2.sandboxes.get("sbx_1").sb.exec = async (...a: any[]) => { await slow; return realExec(...a); };
    const exec = driver.exec("make", {});
    await new Promise((r) => setTimeout(r, 10));
    const stopping = m.stop(nina);
    await new Promise((r) => setTimeout(r, 30));
    expect(v2.calls.some((c) => c.startsWith("snapshot"))).toBe(false);
    finish();
    await exec;
    await stopping;
    expect(m.live("nina").status).toBe("hibernated");
  });

  test("reset deletes the VM and every snapshot of this computer (never another's), then a fresh VM from the image; delete the same and forgets it", async () => {
    const { m } = setup();
    const other = (id: string, label: string) => v2.snapshots.set(id, { id, name: computerSnapshotName(label, v2.clock), status: "ready", sandboxId: "x", reads: 0, createdAt: "" });
    other("snap_other_instance", "another-instance:nina");
    other("snap_other_computer", m.labelValue("nina-2"));
    await m.ensure(nina, sb());
    await m.stop(nina);
    await m.ensure(nina, sb());
    await m.stop(nina);
    // pruning after a hibernation never touches another computer's or instance's snapshots
    expect([...v2.snapshots.keys()].sort()).toEqual(["snap_2", "snap_other_computer", "snap_other_instance"]);
    await m.reset(nina, sb());
    expect([...v2.snapshots.keys()].sort()).toEqual(["snap_other_computer", "snap_other_instance"]);
    expect(v2.creates).toHaveLength(2);
    expect(v2.creates[1].opts.idempotencyKey).not.toBe(v2.creates[0].opts.idempotencyKey);
    expect(m.live("nina")).toMatchObject({ status: "running", remoteId: "sbx_3" });
    expect(m.live("nina").lastSnapshot).toBeUndefined();

    await m.stop(nina);
    await m.delete(nina);
    expect([...v2.snapshots.keys()].sort()).toEqual(["snap_other_computer", "snap_other_instance"]);
    expect(running()).toEqual([]);
    expect(m.read().nina).toMatchObject({ status: "missing", deletedAt: expect.any(String) });
  });

  test("the API shows a hibernated computer with its last snapshot; start wakes it", async () => {
    const { m } = setup();
    await m.ensure(nina, sb());
    await m.stop(nina);
    const { computerRoutes } = await import("../server/routes/computers.js");
    const routes = computerRoutes({
      computers: () => [nina], settings: () => ({ sandbox: { providers: { daytona: { api: "v2" } } } }) as any, agents: async () => [],
      manager: () => m, save: async () => {}, sandboxFor: () => sb(), emit: () => {},
    });
    const got = await (await routes.request("/nina")).json();
    expect(got.data).toMatchObject({ status: "hibernated", lastSnapshot: { at: expect.any(String), memoryBytes: 224_000_000, diskBytes: 1_500_000_000 } });
    const started = await (await routes.request("/nina/start", { method: "POST" })).json();
    expect(started.data).toMatchObject({ status: "running", remoteId: "sbx_2" });
    expect(v2.restores.map((r) => r.snapshot)).toEqual(["snap_1"]);
  });

  // ── live e2e findings (2026-11-21) ────────────────────────────────────

  test("restart and reset while the search still lists the just-deleted VM as started: it is read by id and skipped (no 'sandbox … is destroyed')", async () => {
    v2.staleSearch = true;
    v2.destroyedVisible = true;
    const { m } = setup();
    await m.ensure(nina, sb());
    // restart = hibernate (snapshot, VM deleted) then wake: the stale hit sbx_1 must not be connected to
    const restarted = await m.restart(nina, sb());
    expect(restarted).toMatchObject({ status: "running", remoteId: "sbx_2" });
    expect(v2.restores.map((r) => r.snapshot)).toEqual(["snap_1"]);
    expect(v2.calls.some((c) => /^start sbx_1 /.test(c))).toBe(false);
    // reset right after: sbx_2 is deleted and still listed; the new VM comes from the image
    const reset = await m.reset(nina, sb());
    expect(reset).toMatchObject({ status: "running", remoteId: "sbx_3" });
    expect(v2.creates).toHaveLength(2);
    // restart right after the reset (KjSL live): the same
    expect(await m.restart(nina, sb())).toMatchObject({ status: "running", remoteId: "sbx_4" });
    // a stale hit never counts as this computer's running VM
    expect((await m.refresh(nina)).remoteId).toBe("sbx_4");
  });

  test("reset is atomic for the person: the wipe done, a failed create is tried again; when it still fails the reset reports success with a note, never 'try again later'", async () => {
    const { m } = setup();
    await m.ensure(nina, sb());
    v2.createFailures = 1;
    expect(await m.reset(nina, sb())).toMatchObject({ status: "running", remoteId: "sbx_2" });

    const { computerRoutes } = await import("../server/routes/computers.js");
    const routes = computerRoutes({
      computers: () => [nina], settings: () => ({ sandbox: { providers: { daytona: { api: "v2" } } } }) as any, agents: async () => [],
      manager: () => m, save: async () => {}, sandboxFor: () => sb(), emit: () => {},
    });
    v2.createFailures = 99;
    const res = await routes.request("/nina/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ status: "missing", note: expect.stringMatching(/was reset .* created on its next use or start/) });
    expect(running()).toEqual([]);
    // its next use makes it
    v2.createFailures = 0;
    expect((await m.start(nina, sb())).status).toBe("running");
  });

  test("delete is authoritative: a run, a queued wake or a config without it never brings the VM back (orphan seen live 2 s after a delete)", async () => {
    const { m } = setup();
    const configured = new Set(["nina"]);
    m.isConfigured = (id) => configured.has(id);
    const driver = await m.attach(nina, sb());
    // a start queued right behind the delete (a tailnet logout, a config reload, a wake)
    const deleting = m.delete(nina);
    const racing = m.ensure(nina, sb());
    await deleting;
    await expect(racing).rejects.toThrow(/Computer "nina" was deleted/);
    // the run that had it attached: its next command does not make a new VM
    await expect(driver.exec("echo hi", {})).rejects.toThrow(/was deleted/);
    await expect(m.start(nina, sb())).rejects.toThrow(/was deleted/);
    // the config without it (after the route saved): still nothing
    configured.delete("nina");
    await expect(m.ensure(nina, sb())).rejects.toThrow(/was deleted/);
    await m.idleTick([nina]);
    expect(v2.creates).toHaveLength(1);
    expect(v2.restores).toHaveLength(0);
    expect(running()).toEqual([]);
    // no state written back for it (lastUsedAt from a heartbeat)
    m.touch(nina, undefined, true);
    expect(m.read().nina).toMatchObject({ status: "missing", deletedAt: expect.any(String) });
    expect(m.read().nina.lastUsedAt).toBeUndefined();

    // another process (a task runner, no config hook) sees the tombstone
    const other = new ComputerManager(m.polpoDir, { now: () => v2.clock, sleep: async () => {} });
    await expect(other.ensure(nina, sb())).rejects.toThrow(/was deleted/);

    // created again with the same id: machines again
    configured.add("nina");
    await m.revive("nina");
    expect((await m.start(nina, sb())).status).toBe("running");
    expect(v2.creates).toHaveLength(2);
  });

  test("the delete route marks the computer deleted before its VM goes, and POST creates it again", async () => {
    const { m } = setup();
    const state = { computers: [nina] as ComputerConfig[] };
    m.isConfigured = (id) => state.computers.some((c) => c.id === id);
    await m.ensure(nina, sb());
    const { computerRoutes } = await import("../server/routes/computers.js");
    const routes = computerRoutes({
      computers: () => state.computers, settings: () => ({ sandbox: { providers: { daytona: { api: "v2" } } } }) as any, agents: async () => [],
      manager: () => m, save: async (list) => { state.computers = list; }, sandboxFor: () => sb(), emit: () => {},
    });
    const del = await routes.request("/nina", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
    expect(del.status).toBe(200);
    await expect(m.ensure(nina, sb())).rejects.toThrow(/was deleted/);
    expect(running()).toEqual([]);
    const again = await routes.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "nina", kind: "daytona", start: true }) });
    expect(again.status).toBe(201);
    expect(running()).toHaveLength(1);
  });

  test("network allowlist is checked when saved (REST): an invalid entry or an IP address on v2 is a 400 with the reason; a v2 network change needs no reset", async () => {
    const { m } = setup();
    const state = { computers: [{ ...nina, network: allow("example.com") }] as ComputerConfig[] };
    const settings = { sandbox: { providers: { daytona: { api: "v2" } } } } as any;
    const { computerRoutes } = await import("../server/routes/computers.js");
    const routes = computerRoutes({
      computers: () => state.computers, settings: () => settings, agents: async () => [],
      manager: () => m, save: async (list) => { state.computers = list; }, sandboxFor: (c) => sb(c), emit: () => {},
    });
    const patch = (network: unknown) => routes.request("/nina", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ network }) });
    const bad = await patch({ mode: "allowlist", allow: ["not a host!!", "300.1.1.1"] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/not a host name: "not a host!!", "300\.1\.1\.1"/);
    const ip = await patch({ mode: "allowlist", allow: ["*.wikipedia.org", "1.1.1.1/32"] });
    expect(ip.status).toBe(400);
    expect((await ip.json()).error).toMatch(/Daytona v2 applies domain rules only; use host names \(1\.1\.1\.1\/32/);
    expect(state.computers[0]!.network).toEqual(allow("example.com"));
    // a valid change on a computer that has a machine: applied at its next start or wake, no reset
    await m.ensure(nina, sb());
    const okRes = await patch({ mode: "allowlist", allow: ["*.wikipedia.org"] });
    expect(okRes.status).toBe(200);
    const note = (await okRes.json()).data.note as string;
    expect(note).toMatch(/applies when it next starts or wakes/);
    expect(note).not.toMatch(/reset the computer/);
    // POST validates too
    const post = await routes.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "box2", kind: "daytona", network: { mode: "allowlist", allow: ["8.8.8.8"] } }) });
    expect(post.status).toBe(400);
    // a rule saved by hand that the provider refuses: a 400 on start, not a 502 "try again later"
    state.computers = [{ ...nina, network: allow("bad host!") }];
    await m.stop(nina);
    const start = await routes.request("/nina/start", { method: "POST" });
    expect(start.status).toBe(400);
    expect((await start.json()).error).toMatch(/not a host name or IP address: "bad host!".*Fix the computer's network rule/);
  });
});

// ── agent harnesses on v2: processes, ports, hibernation ─────────────────

describe("agent harnesses on Daytona v2", () => {
  const nina: ComputerConfig = { id: "nina", name: "Nina", kind: "daytona", lifecycle: { idleStopMinutes: 15 } };
  const sb = () => sandbox({ computer: nina });
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "polpo-daytona-v2-harness-"));
    dirs.push(dir);
    return new ComputerManager(dir, { now: () => v2.clock, sleep: async (ms) => { v2.clock += ms; } });
  };
  const read = async (stream: ReadableStream<Uint8Array>) => {
    let out = "";
    for await (const c of stream as unknown as AsyncIterable<Uint8Array>) out += new TextDecoder().decode(c);
    return out;
  };

  test("spawn: a detached process (bash -c, cwd, env, logs kept), stdout and stderr from its log stream, its exit", async () => {
    const driver = await remoteAdapter("daytona").create(spec(sandbox()));
    const p = await driver.spawn!("node bridge.mjs", { cwd: "/root/work", env: { BRIDGE_WS_PORT: "4000" } });
    expect(v2.processStarts[0]).toEqual({ command: { argv: ["bash", "-c", "node bridge.mjs"] }, opts: { cwd: "/root/work", env: { BRIDGE_WS_PORT: "4000" }, keepLogs: "until_cleanup" } });
    expect(await read(p.stdout)).toBe("bridge ready\n");
    expect(await read(p.stderr)).toBe("warn\n");
    expect(await p.wait()).toEqual({ exitCode: 0 });
    await p.kill();
    expect(v2.calls).toContain(`process.kill ${p.id} TERM`);
    // reconnect by id (after a wake)
    const again = await driver.connectProcess!(p.id);
    expect(again.id).toBe(p.id);
  });

  test("a process whose VM is gone reads as killed (137), never a rejection", async () => {
    const driver = await remoteAdapter("daytona").create(spec(sandbox()));
    const p = await driver.spawn!("sleep 1000", {});
    v2.sandboxes.get(driver.remoteId)!.s.state = "destroyed";
    expect(await p.wait()).toEqual({ exitCode: 137 });
  });

  test("port endpoint: a signed link for long uses (no token header), the preview token header for short ones; ws:// for WebSockets", async () => {
    const driver = await remoteAdapter("daytona").create(spec(sandbox()));
    const id = driver.remoteId;
    expect(await driver.portEndpoint!(4001, { protocol: "ws", ttlSeconds: 86_400 })).toEqual({
      url: `wss://4001-signed-${id}.proxy.example`, headers: { "X-Daytona-Skip-Preview-Warning": "true" }, expiresAt: "2026-11-22T10:00:00Z",
    });
    expect(v2.calls).toContain(`signedPreviewLink ${id} 4001 86400`);
    expect(await driver.portEndpoint!(4001, { protocol: "ws", ttlSeconds: 600 })).toEqual({
      url: `wss://4001-${id}.proxy.example`, headers: { "X-Daytona-Skip-Preview-Warning": "true", "X-Daytona-Preview-Token": `tok-${id}` }, expiresAt: "2026-11-21T11:00:00Z",
    });
  });

  test("a computer's driver passes spawn and ports through to its current VM; a held turn keeps it from hibernating as idle", async () => {
    const m = setup();
    const d = await m.attach(nina, sb());
    const p = await d.spawn!("node bridge.mjs", {});
    expect(p.id).toBe("proc_1");
    expect((await d.portEndpoint!(4000, { protocol: "ws" })).url).toMatch(/^wss:\/\/4000-signed-sbx_1\./);
    const release = d.hold!();
    v2.clock += 16 * 60_000;
    await m.idleTick([nina]);
    expect(v2.calls.some((c) => c.startsWith("snapshot "))).toBe(false);
    release();
    v2.clock += 16 * 60_000;
    await m.idleTick([nina]);
    expect(v2.calls.some((c) => c.startsWith("snapshot "))).toBe(true);
  });

  test("hibernation: live harness sessions on the computer park (memory) before the snapshot; a reset stops them (disk)", async () => {
    const { liveHarnessSessions } = await import("../harness/live-sessions.js");
    liveHarnessSessions.clear();
    const parked: string[] = [];
    const unregister = liveHarnessSessions.register({
      key: "task:t1", agent: "ada", computerId: "nina",
      suspend: async (mode, reason) => { parked.push(`${mode}:${reason}:${v2.calls.filter((c) => c.startsWith("snapshot ")).length}`); },
    });
    liveHarnessSessions.register({ key: "task:other", agent: "bob", computerId: "other", suspend: async () => { parked.push("wrong computer"); } });
    const m = setup();
    await m.ensure(nina, sb());
    await m.stop(nina);
    // parked before any snapshot was taken
    expect(parked).toEqual(["memory:stop:0"]);
    await m.reset(nina, sb());
    expect(parked).toEqual(["memory:stop:0", "disk:reset:1"]);
    unregister();
    liveHarnessSessions.clear();
  });
});

// ── deleted at the provider (outside Polpo) ──────────────────────────────

describe("Daytona v2 computers deleted at the provider", () => {
  const nina: ComputerConfig = { id: "nina", name: "Nina", kind: "daytona", lifecycle: { idleStopMinutes: 15 } };
  const sb = (c: ComputerConfig = nina) => sandbox({ computer: c });
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "polpo-daytona-v2-deleted-"));
    dirs.push(dir);
    const m = new ComputerManager(dir, { now: () => v2.clock, sleep: async (ms) => { v2.clock += ms; } });
    const notices: string[] = [];
    const changes: string[] = [];
    m.onNotice = (_id, _level, message) => notices.push(message);
    m.onChange = (_id, live) => changes.push(live.status);
    return { m, notices, changes };
  };
  /** The person deletes the VM in the Daytona dashboard. */
  const deleteVm = (id: string) => { v2.sandboxes.get(id)!.s.state = "destroyed"; };

  test("a hibernated computer whose snapshot was deleted: deleted (not hibernated), its snapshots forgotten, an event", async () => {
    const { m, notices, changes } = setup();
    await m.ensure(nina, sb());
    await m.stop(nina);
    expect((await m.refresh(nina)).status).toBe("hibernated");
    v2.snapshots.clear(); // deleted in the dashboard
    // asked a moment ago: the answer is reused (the list page asks for every computer)
    expect((await m.refresh(nina)).status).toBe("hibernated");
    const live = await m.refresh(nina, undefined, { force: true });
    expect(live).toMatchObject({ status: "deleted", deletedAtProvider: new Date(v2.clock).toISOString(), notice: expect.stringMatching(/its snapshots were deleted at the provider/) });
    expect(live.lastSnapshot).toBeUndefined();
    expect(live.snapshotCount).toBeUndefined();
    expect(m.read().nina.snapshots).toEqual([]);
    expect(changes.at(-1)).toBe("deleted");
    expect(notices.at(-1)).toMatch(/deleted at the provider/);
    // announced once
    v2.clock += 60_000;
    expect((await m.refresh(nina, undefined, { force: true })).status).toBe("deleted");
    expect(changes.filter((s) => s === "deleted")).toHaveLength(1);
  });

  test("the tracked snapshot is gone but an older one is listed: still hibernated (it wakes from that one)", async () => {
    const { m } = setup();
    await m.ensure(nina, sb());
    await m.stop(nina);
    const tracked = m.read().nina.snapshots!;
    const kept = v2.snapshots.get(tracked[0]!.id)!;
    v2.snapshots.set("snap_old", { ...kept, id: "snap_old" });
    v2.snapshots.delete(tracked[0]!.id);
    const live = await m.refresh(nina, undefined, { force: true });
    expect(live.status).toBe("hibernated");
    expect(live.snapshotCount).toBe(1);
    expect(m.read().nina.snapshots!.map((x) => x.id)).toEqual(["snap_old"]);
  });

  test("a running computer whose VM was deleted (no snapshot): deleted; its next use makes a VM from the image and says so", async () => {
    const { m, notices } = setup();
    const first = await m.ensure(nina, sb());
    deleteVm(first.remoteId);
    expect((await m.refresh(nina, undefined, { force: true })).status).toBe("deleted");
    const warnings: string[] = [];
    const driver = await m.ensure(nina, sb(), (w) => warnings.push(w));
    expect(driver.remoteId).not.toBe(first.remoteId);
    expect(v2.creates).toHaveLength(2);
    expect(v2.restores).toHaveLength(0);
    const live = m.live("nina");
    expect(live).toMatchObject({ status: "running", notice: expect.stringMatching(/deleted at the provider: a new one was made from the image/) });
    expect(live.deletedAtProvider).toBeUndefined();
    expect(warnings[0]).toMatch(/Computer "nina": Its machine had been deleted at the provider/);
    expect(notices.at(-1)).toMatch(/a new one was made from the image/);
  });

  test("a woken VM deleted while it ran, its snapshot left: hibernated with a notice (its next use restores it)", async () => {
    const { m } = setup();
    await m.ensure(nina, sb());
    await m.stop(nina);
    const second = await m.ensure(nina, sb());
    deleteVm(second.remoteId);
    expect(await m.refresh(nina, undefined, { force: true })).toMatchObject({ status: "hibernated", notice: expect.stringMatching(/Its VM is gone/) });
  });

  test("reconcile: one search (and one snapshot listing) for all computers; only the ones that disagree are checked", async () => {
    const { m } = setup();
    const box: ComputerConfig = { id: "box", name: "Box", kind: "daytona" };
    await m.ensure(nina, sb());
    await m.ensure(box, sb(box));
    await m.stop(box);
    v2.calls.length = 0;
    expect(await m.reconcile([nina, box])).toEqual([]);
    expect(v2.calls.filter((c) => c.startsWith("search"))).toEqual([`search ${JSON.stringify({ "polpo-scope": "computer" })}`]);
    // both deleted at the provider: nina's VM, box's snapshot
    deleteVm(m.read().nina.remoteId!);
    v2.snapshots.clear();
    expect(await m.reconcile([nina, box])).toEqual(["nina", "box"]);
    expect(m.live("nina").status).toBe("deleted");
    expect(m.live("box").status).toBe("deleted");
    // a provider that cannot be asked teaches nothing
    v2.searchError = new Error("boom");
    expect(await m.reconcile([nina, box])).toEqual([]);
  });
});
