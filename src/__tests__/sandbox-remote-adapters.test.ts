import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { EffectiveSandbox, SandboxNetwork } from "@polpo-ai/core/sandbox";

// ── mocked SDKs (no network, no credentials) ────────────────────────────

const daytona = vi.hoisted(() => ({ created: [] as any[], ctor: [] as any[], exec: [] as any[] }));
const e2b = vi.hoisted(() => ({ created: [] as any[] }));

/** Daytona's executeCommand: one string with stdout and stderr interleaved, and the exit code. */
function runLikeDaytona(command: string, cwd?: string, env?: Record<string, string>) {
  const r = spawnSync("bash", ["-c", `${command} 2>&1`], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  return { exitCode: r.status ?? 1, result: r.stdout };
}

vi.mock("@daytona/sdk", () => ({
  Daytona: class {
    constructor(opts: unknown) { daytona.ctor.push(opts); }
    async create(params: any, opts: any) {
      daytona.created.push({ params, opts });
      return {
        id: "dt-1", state: "started",
        process: {
          executeCommand: async (cmd: string, cwd?: string, env?: Record<string, string>, timeout?: number) => {
            daytona.exec.push({ cmd, cwd, env, timeout });
            return runLikeDaytona(cmd, cwd, env);
          },
        },
        fs: {}, delete: async () => undefined,
      };
    }
  },
}));

vi.mock("e2b", () => ({
  CommandExitError: class extends Error {},
  Sandbox: {
    create: async (...args: any[]) => {
      e2b.created.push(args);
      return { sandboxId: "e2b-1" };
    },
  },
}));

vi.mock("../sandbox/remote-providers.js", () => ({
  remoteProviderCredentials: async (id: string) => ({ apiKey: `key-${id}` }),
}));

const {
  DAYTONA_NETWORK_LIMITS, SandboxNetworkConfigError, classifyAllowEntries, daytonaExecWrapper, daytonaNetworkParams,
  daytonaResources, e2bNetworkOpts, remoteAdapter, resetRemoteAdapters, splitDaytonaOutput,
} = await import("../sandbox/remote-adapters.js");

const allow = (...hosts: string[]): SandboxNetwork => ({ mode: "allowlist", allow: hosts });

function sandbox(over: Partial<EffectiveSandbox> = {}): EffectiveSandbox {
  return { provider: "daytona", network: { mode: "open" }, resources: {}, providerOptions: {}, denied: [], ...over };
}

beforeEach(() => {
  daytona.created.length = 0;
  daytona.exec.length = 0;
  e2b.created.length = 0;
  resetRemoteAdapters();
});

// ── network rules ───────────────────────────────────────────────────────

describe("allowlist entries", () => {
  test("ports dropped, case folded, duplicates removed, kinds told apart", () => {
    const entries = classifyAllowEntries(["API.example.com:443", "api.example.com", "*.github.com", "1.2.3.4", "10.0.0.0/8", "[2001:db8::1]:22", "2001:db8::2", "https://x.com/path", " "]);
    expect(entries.map((e) => [e.kind, e.value])).toEqual([
      ["domain", "api.example.com"],
      ["domain", "*.github.com"],
      ["ipv4", "1.2.3.4/32"],
      ["ipv4", "10.0.0.0/8"],
      ["ipv6", "2001:db8::1"],
      ["ipv6", "2001:db8::2"],
      ["invalid", "https://x.com/path"],
    ]);
  });
});

describe("Daytona network mapping", () => {
  test("deny blocks everything; open and unrestricted set nothing", () => {
    expect(daytonaNetworkParams({ mode: "deny" })).toEqual({ networkBlockAll: true });
    expect(daytonaNetworkParams({ mode: "open" })).toEqual({});
    expect(daytonaNetworkParams({ mode: "unrestricted" })).toEqual({});
  });

  test("an empty allowlist blocks everything", () => {
    expect(daytonaNetworkParams(allow())).toEqual({ networkBlockAll: true });
    expect(daytonaNetworkParams({ mode: "allowlist" })).toEqual({ networkBlockAll: true });
  });

  test("host names go to domainAllowList as written (wildcards kept, nothing resolved, no resolvers added)", () => {
    const hosts = ["registry.npmjs.org", "*.github.com", "pypi.org:443", "api.openai.com", "example.com", "a.example.com", "b.example.com", "c.example.com"];
    const params = daytonaNetworkParams(allow(...hosts));
    expect(params).toEqual({ domainAllowList: "registry.npmjs.org,*.github.com,pypi.org,api.openai.com,example.com,a.example.com,b.example.com,c.example.com" });
    expect(params.networkAllowList).toBeUndefined();
  });

  test("100 host names fit, 101 are an error (no truncation)", () => {
    const many = Array.from({ length: DAYTONA_NETWORK_LIMITS.domains + 1 }, (_, i) => `h${i}.example.com`);
    expect(daytonaNetworkParams(allow(...many.slice(0, 100))).domainAllowList!.split(",")).toHaveLength(100);
    expect(() => daytonaNetworkParams(allow(...many))).toThrow(SandboxNetworkConfigError);
    expect(() => daytonaNetworkParams(allow(...many))).toThrow(/101 host names, Daytona accepts at most 100/);
  });

  test("IPv4 addresses and ranges go to networkAllowList as CIDRs, at most 10", () => {
    expect(daytonaNetworkParams(allow("1.2.3.4", "10.0.0.0/8", "1.2.3.4:22"))).toEqual({ networkAllowList: "1.2.3.4/32,10.0.0.0/8" });
    const ips = Array.from({ length: 11 }, (_, i) => `10.0.0.${i + 1}`);
    expect(daytonaNetworkParams(allow(...ips.slice(0, 10))).networkAllowList!.split(",")).toHaveLength(10);
    expect(() => daytonaNetworkParams(allow(...ips))).toThrow(/11 IP addresses or ranges, Daytona accepts at most 10/);
  });

  test("host names and addresses together are an error (Daytona takes one list per sandbox)", () => {
    expect(() => daytonaNetworkParams(allow("example.com", "1.2.3.4"))).toThrow(/host names or IP addresses in one sandbox, not both/);
  });

  test("IPv6 and malformed entries are errors", () => {
    expect(() => daytonaNetworkParams(allow("example.com", "2001:db8::1"))).toThrow(/does not filter IPv6/);
    expect(() => daytonaNetworkParams(allow("https://example.com/x"))).toThrow(/not a host name or IPv4 address: "https:\/\/example.com\/x"/);
    expect(() => daytonaNetworkParams(allow("1.2.3.4/40"))).toThrow(SandboxNetworkConfigError);
  });
});

describe("E2B network mapping", () => {
  test("deny turns internet access off; open sets nothing", () => {
    expect(e2bNetworkOpts({ mode: "deny" })).toEqual({ allowInternetAccess: false });
    expect(e2bNetworkOpts({ mode: "open" })).toEqual({});
  });

  test("allowlist: hosts and addresses in allowOut, everything else denied; a wildcard also lists its base domain", () => {
    expect(e2bNetworkOpts(allow("*.github.com", "pypi.org:443", "1.2.3.4", "10.0.0.0/8", "PYPI.org"))).toEqual({
      network: { allowOut: ["github.com", "*.github.com", "pypi.org", "1.2.3.4", "10.0.0.0/8"], denyOut: ["0.0.0.0/0"] },
    });
    expect(e2bNetworkOpts(allow())).toEqual({ network: { allowOut: [], denyOut: ["0.0.0.0/0"] } });
    expect(() => e2bNetworkOpts(allow("not a host"))).toThrow(SandboxNetworkConfigError);
  });
});

// ── resources ───────────────────────────────────────────────────────────

describe("Daytona resources", () => {
  test("nothing requested: nothing sent, no warning", () => {
    expect(daytonaResources(sandbox())).toEqual({});
  });

  test("from an image: cores and GiB (rounded up)", () => {
    expect(daytonaResources(sandbox({ resources: { cpus: 2, memoryMb: 3000, diskMb: 5120 }, providerOptions: { image: "node:22" } })))
      .toEqual({ resources: { cpu: 2, memory: 3, disk: 5 } });
  });

  test("from a snapshot: the snapshot's size applies and the request is reported", () => {
    const r = daytonaResources(sandbox({ resources: { cpus: 4 }, providerOptions: { snapshot: "polpo-runner-1" } }));
    expect(r.resources).toBeUndefined();
    expect(r.warning).toMatch(/polpo-runner-1.*4 CPU not applied/);
  });
});

// ── adapters with the mocked SDKs ───────────────────────────────────────

describe("DaytonaAdapter", () => {
  const spec = (s: EffectiveSandbox, onWarning?: (m: string) => void) => ({ sandbox: s, labels: { polpo: "1" }, lifetimeMinutes: 20, keep: false, onWarning });

  test("create sends domainAllowList (no resolved IPs) and the snapshot", async () => {
    await remoteAdapter("daytona").create(spec(sandbox({ network: allow("*.github.com", "registry.npmjs.org"), providerOptions: { snapshot: "polpo-runner-1" } })));
    const { params, opts } = daytona.created[0];
    expect(params).toMatchObject({ autoStopInterval: 20, labels: { polpo: "1" }, ephemeral: true, snapshot: "polpo-runner-1", domainAllowList: "*.github.com,registry.npmjs.org" });
    expect(params.networkAllowList).toBeUndefined();
    expect(params.networkBlockAll).toBeUndefined();
    expect(params.resources).toBeUndefined();
    expect(opts).toEqual({ timeout: 180 });
  });

  test("an allowlist Daytona cannot enforce fails before any sandbox is created", async () => {
    const ips = Array.from({ length: 12 }, (_, i) => `10.0.0.${i + 1}`);
    await expect(remoteAdapter("daytona").create(spec(sandbox({ network: allow(...ips) })))).rejects.toThrow(/at most 10/);
    expect(daytona.created).toHaveLength(0);
  });

  test("resources: sent with an image, reported with a snapshot", async () => {
    const warnings: string[] = [];
    await remoteAdapter("daytona").create(spec(sandbox({ resources: { cpus: 2, memoryMb: 4096 }, providerOptions: { image: "node:22-bookworm-slim" } }), (m) => warnings.push(m)));
    expect(daytona.created[0].params).toMatchObject({ image: "node:22-bookworm-slim", resources: { cpu: 2, memory: 4 } });
    expect(warnings).toEqual([]);
    await remoteAdapter("daytona").create(spec(sandbox({ resources: { cpus: 2 }, providerOptions: { snapshot: "snap" } }), (m) => warnings.push(m)));
    expect(daytona.created[1].params.resources).toBeUndefined();
    expect(daytona.created[1].params.image).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  test("exec returns stdout and stderr apart, with the exit code", async () => {
    const driver = await remoteAdapter("daytona").create(spec(sandbox()));
    const r = await driver.exec(`echo out1; echo err1 >&2; printf 'out2'; echo "it's" >&2; exit 3`, { env: { X: "1" }, timeoutMs: 1500 });
    expect(r).toEqual({ exitCode: 3, stdout: "out1\nout2", stderr: "err1\nit's\n" });
    expect(daytona.exec[0]).toMatchObject({ env: { X: "1" }, timeout: 2 });
    const ok = await driver.exec("echo hi", {});
    expect(ok).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "" });
  });

  test("exec: env and cwd reach the command", async () => {
    const driver = await remoteAdapter("daytona").create(spec(sandbox()));
    const r = await driver.exec(`echo "$GREETING from $(pwd)"; ls /nonexistent-polpo-dir`, { cwd: "/tmp", env: { GREETING: "hello" } });
    expect(r.stdout).toBe("hello from /tmp\n");
    expect(r.stderr).toMatch(/nonexistent-polpo-dir/);
    expect(r.exitCode).not.toBe(0);
  });
});

describe("Daytona exec wrapper", () => {
  test("output without the marker (wrapper killed) is all stdout", () => {
    expect(splitDaytonaOutput("partial", "\n__M__\n")).toEqual({ stdout: "partial", stderr: "" });
  });

  test("the wrapper is plain bash", () => {
    const marker = "\n__M__\n";
    const r = runLikeDaytona(`bash -c '${daytonaExecWrapper("echo a; echo b >&2; exit 7", marker).replace(/'/g, `'\\''`)}'`);
    expect(r.exitCode).toBe(7);
    expect(splitDaytonaOutput(r.result, marker)).toEqual({ stdout: "a\n", stderr: "b\n" });
  });
});

describe("E2BAdapter", () => {
  test("create maps the allowlist and reports resources it cannot apply", async () => {
    const warnings: string[] = [];
    await remoteAdapter("e2b").create({
      sandbox: sandbox({ provider: "e2b", network: allow("*.github.com"), resources: { memoryMb: 8192 }, providerOptions: { template: "polpo-runner" } }),
      labels: { polpo: "1" }, lifetimeMinutes: 10, keep: true, onWarning: (m) => warnings.push(m),
    });
    const [template, opts] = e2b.created[0];
    expect(template).toBe("polpo-runner");
    expect(opts).toMatchObject({ apiKey: "key-e2b", timeoutMs: 600_000, metadata: { polpo: "1" }, lifecycle: { onTimeout: "pause" }, network: { allowOut: ["github.com", "*.github.com"], denyOut: ["0.0.0.0/0"] } });
    expect(warnings[0]).toMatch(/E2B sizes a sandbox by its template/);
  });
});
