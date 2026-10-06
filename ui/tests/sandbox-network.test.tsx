import { describe, expect, test } from "vitest";
import {
  allowEntryFor, allowlistCovers, alreadyAllowed, approvalBlocker, describeSandbox, NETWORK_MODES, planAllowForAgent, planAllowForEveryone,
  type NetworkDeniedEntry, type SandboxOverview,
} from "../src/lib/sandbox-api";

const sb = (mode: any, allow?: string[]) => ({ provider: "bwrap" as const, network: { mode, allow }, resources: {} });
const overview = (instance: any, agentSettings: any = null): SandboxOverview => ({
  available: ["local", "bwrap"], settings: instance ? { network: instance } : null, polpo: sb("open"),
  agents: [{ name: "dev", settings: agentSettings, task: sb(agentSettings?.network?.mode ?? instance?.mode ?? "open", agentSettings?.network?.allow ?? instance?.allow), chat: sb("open") }],
});
const entry = (over: Partial<NetworkDeniedEntry> = {}): NetworkDeniedEntry =>
  ({ agentName: "dev", scope: "task", host: "api.x.com", port: 443, reason: "not-allowed", count: 2, lastAt: "2026-01-01T00:00:00Z", ...over });

describe("sandbox network UI helpers", () => {
  test("unrestricted is offered with a warning and described", () => {
    const m = NETWORK_MODES.find((x) => x.id === "unrestricted")!;
    expect(m.description).toMatch(/Risky/);
    expect(describeSandbox(sb("unrestricted"))).toContain("unrestricted");
  });
  test("allow entries keep non-web ports", () => {
    expect(allowEntryFor({ host: "a.com", port: 443 })).toBe("a.com");
    expect(allowEntryFor({ host: "github.com", port: 22 })).toBe("github.com:22");
    expect(allowlistCovers(["*.a.com", "g.com:22"], "x.a.com", 443)).toBe(true);
    expect(allowlistCovers(["g.com:22"], "g.com", 443)).toBe(false);
  });
  test("allow for an agent starts from the instance list when it has none", () => {
    const plan = planAllowForAgent(overview({ mode: "allowlist", allow: ["github.com"] }, { resources: { cpus: 1 } }), entry())!;
    expect(plan.settings).toEqual({ resources: { cpus: 1 }, network: { mode: "allowlist", allow: ["github.com", "api.x.com"] } });
    const own = planAllowForAgent(overview({ mode: "allowlist", allow: ["github.com"] }, { network: { mode: "allowlist", allow: ["a.com"] } }), entry())!;
    expect(own.settings.network?.allow).toEqual(["a.com", "api.x.com"]);
  });
  test("allow for everyone extends the instance list and agents with their own", () => {
    const plan = planAllowForEveryone(overview({ mode: "allowlist", allow: ["github.com"] }, { network: { mode: "allowlist", allow: ["a.com"] } }), entry())!;
    expect(plan.instance.network?.allow).toEqual(["github.com", "api.x.com"]);
    expect(plan.agents).toEqual([{ name: "dev", settings: { network: { mode: "allowlist", allow: ["a.com", "api.x.com"] } } }]);
    expect(planAllowForEveryone(overview({ mode: "open" }), entry())).toBeNull();
  });
  test("private addresses cannot be approved with one click; approved hosts disappear", () => {
    expect(approvalBlocker(entry({ reason: "private-address" }))).toMatch(/private/);
    expect(approvalBlocker(entry())).toBeNull();
    expect(alreadyAllowed(overview({ mode: "allowlist", allow: ["api.x.com"] }), entry())).toBe(true);
    expect(alreadyAllowed(overview({ mode: "allowlist", allow: ["b.com"] }), entry())).toBe(false);
  });
});
