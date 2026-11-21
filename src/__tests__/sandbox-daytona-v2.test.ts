/**
 * Daytona v2 (providers.daytona.api = "v2"): Linux VMs through @daytona/sdk 2.x (aliased
 * @daytona/sdk-v2), with the SDKs mocked (no network, no credentials).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DAYTONA_V2_RUNNER_IMAGE, daytonaApiVersion, daytonaProviderErrors,
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
    stop: async () => { v2.calls.push(`stop ${s.id}`); throw Object.assign(new Error("A sandbox that is not persistent cannot be stopped"), { statusCode: 400 }); },
    pause: async () => { v2.calls.push(`pause ${s.id}`); s.state = "paused"; },
    resume: async () => { v2.calls.push(`resume ${s.id}`); s.state = "started"; },
    delete: async () => { v2.calls.push(`delete ${s.id}`); s.state = "destroyed"; },
    refreshData: async () => undefined,
    resetIdleTimer: async () => { v2.calls.push(`idle-reset ${s.id}`); return {}; },
    updateLifecyclePolicy: async (p: any) => { v2.lifecycleUpdates.push(p); return {}; },
    exec: async (command: any, opts: any) => {
      v2.execs.push({ command, opts });
      return v2.execResult ?? { processId: "p1", reason: "exited", exitCode: 0, stdout: "out\n", stderr: "err\n", output: "out\nerr\n", logs: [] };
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
          v2.creates.push({ image, opts });
          const id = `sbx_${++v2.n}`;
          const s = addSandbox({ id, state: v2.createdState, sandboxClass: v2.createClass, labels: { ...opts.labels, ...(opts.name ? { name: opts.name } : {}) }, network: opts.networkPolicy });
          return v2.sandboxes.get(s.id).sb;
        },
        get: async (id: string) => {
          const e = v2.sandboxes.get(id);
          if (!e || e.s.state === "destroyed") throw Object.assign(new Error(`sandbox ${id} not found`), { statusCode: 404, code: "NOT_FOUND" });
          return e.sb;
        },
        search: async (opts: any) => {
          if (v2.searchError) throw v2.searchError;
          v2.calls.push(`search ${JSON.stringify(opts.labels)}`);
          const items = [...v2.sandboxes.values()].filter((e) => opts.states.includes(e.s.state) && Object.entries(opts.labels ?? {}).every(([k, v]) => e.s.labels[k] === v)).map((e) => e.sb);
          return { items, total: items.length, totalRelation: "eq", rawTotalRelation: "eq" };
        },
        iter: async function* () { for (const e of v2.sandboxes.values()) yield e.sb; },
        delete: async (id: string) => {
          const e = v2.sandboxes.get(id);
          if (!e) throw Object.assign(new Error("not found"), { statusCode: 404 });
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

vi.mock("../sandbox/remote-providers.js", () => ({
  remoteProviderCredentials: async (id: string) => {
    const o = providerOptions.value;
    return { apiKey: `key-${id}`, ...(o.api === "v2" ? { api: "v2" } : {}), ...(typeof o.image === "string" ? { image: o.image } : {}), ...(typeof o.region === "string" ? { region: o.region } : {}) };
  },
}));

const { remoteAdapter, resetRemoteAdapters, SandboxNetworkConfigError } = await import("../sandbox/remote-adapters.js");
const { daytonaV2NetworkPolicy, daytonaV2Resources, daytonaV2Lifecycle, DAYTONA_V2_COMPUTER_TIMEOUT_SECONDS } = await import("../sandbox/daytona-v2.js");
const { ComputerManager, computerMachineName, computerStatusOf } = await import("../sandbox/computers.js");
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
  });
  v2.sandboxes.clear();
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

  test("one run: deleted after its lifetime; pooled: paused when idle, deleted later; computer: paused, never deleted", () => {
    expect(daytonaV2Lifecycle({ lifetimeMinutes: 20, keep: false })).toEqual({ timeoutSeconds: 1200, onTimeout: "delete", idleExpirySeconds: 1200, onIdleTimeout: "delete" });
    expect(daytonaV2Lifecycle({ lifetimeMinutes: 20, keep: true, deleteAfterStopMinutes: 30 })).toEqual({ timeoutSeconds: 3000, onTimeout: "delete", idleExpirySeconds: -1 });
    const computer = daytonaV2Lifecycle({ lifetimeMinutes: 15, keep: true, persistent: { idleStopMinutes: 15 } });
    expect(computer).toEqual({ timeoutSeconds: DAYTONA_V2_COMPUTER_TIMEOUT_SECONDS, idleExpirySeconds: -1 });
    // Linux VMs accept only "delete" as a policy action: never "pause" or "stop"
    for (const p of [computer, daytonaV2Lifecycle({ lifetimeMinutes: 20, keep: true }), daytonaV2Lifecycle({ lifetimeMinutes: 20, keep: false })]) {
      expect([p.onTimeout, p.onIdleTimeout].filter((a) => a && a !== "delete")).toEqual([]);
    }
    expect(JSON.stringify(computer)).not.toMatch(/delete/);
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

  test("suspend pauses (memory kept), never stops; resume starts a paused VM; keepAlive pushes the idle timer", async () => {
    const driver = await remoteAdapter("daytona").create(spec(sandbox()));
    await driver.suspend();
    expect(v2.calls).toContain("pause sbx_1");
    expect(v2.calls.some((c) => c.startsWith("stop"))).toBe(false);
    await driver.resume();
    expect(v2.calls).toContain("start sbx_1 from paused");
    await driver.keepAlive!(60_000);
    expect(v2.calls).toContain("idle-reset sbx_1");
    await remoteAdapter("daytona").suspendById("sbx_1");
    expect(v2.calls.filter((c) => c === "pause sbx_1")).toHaveLength(2);
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

// ── computers on v2 ─────────────────────────────────────────────────────

describe("computers on Daytona v2", () => {
  const nina: ComputerConfig = { id: "nina", name: "Nina", kind: "daytona", lifecycle: { idleStopMinutes: 15 }, network: allow("example.com") };
  const sb = () => sandbox({ network: nina.network!, computer: nina });
  const manager = () => {
    const dir = mkdtempSync(join(tmpdir(), "polpo-daytona-v2-computer-"));
    dirs.push(dir);
    let now = Date.parse("2026-11-21T10:00:00Z");
    const m = new ComputerManager(dir, { now: () => now });
    return { m, advance: (ms: number) => { now += ms; } };
  };

  test("first use creates a Linux VM with a stable name, its label and a pause-only lifecycle", async () => {
    const { m } = manager();
    await m.ensure(nina, sb());
    expect(v2.creates).toHaveLength(1);
    const { opts } = v2.creates[0];
    expect(opts.name).toBe(computerMachineName(m.labelValue("nina")));
    expect(opts.name).toMatch(/^polpo-computer-[a-z0-9-]+-nina$/);
    expect(opts.labels["polpo-computer"]).toBe(m.labelValue("nina"));
    expect(opts.lifecyclePolicy).toEqual({ timeoutSeconds: DAYTONA_V2_COMPUTER_TIMEOUT_SECONDS, idleExpirySeconds: -1 });
    expect(opts.networkPolicy).toEqual({ blockAll: true, allowDomains: ["example.com"] });
    expect(m.live("nina").status).toBe("running");
  });

  test("idle → paused (never stopped, never deleted); next use resumes the same VM and applies its current network rule", async () => {
    const { m, advance } = manager();
    await m.ensure(nina, sb());
    advance(16 * 60_000);
    await m.idleTick([nina]);
    expect(v2.calls).toContain("pause sbx_1");
    expect(v2.calls.some((c) => c.startsWith("stop") || c.startsWith("delete"))).toBe(false);
    expect(m.live("nina").status).toBe("paused");
    expect(computerStatusOf("daytona", "paused")).toBe("paused");

    const wider = { ...nina, network: allow("example.com", "api.example.com") };
    await m.ensure(wider, sandbox({ network: wider.network, computer: wider }));
    expect(v2.creates).toHaveLength(1); // the same machine
    expect(v2.calls).toContain("start sbx_1 from paused");
    expect(v2.networkUpdates).toEqual([{ policy: { blockAll: true, allowDomains: ["example.com", "api.example.com"] }, ifMatch: "\"etag-sbx_1\"" }]);
    expect(m.live("nina").status).toBe("running");
  });

  test("stop pauses; reset deletes and makes a new VM under the same name", async () => {
    const { m } = manager();
    await m.ensure(nina, sb());
    expect((await m.stop(nina)).status).toBe("paused");
    await m.reset(nina, sb());
    expect(v2.calls).toContain("delete sbx_1");
    expect(v2.creates.map((c) => c.opts.name)).toEqual([computerMachineName(m.labelValue("nina")), computerMachineName(m.labelValue("nina"))]);
  });
});
