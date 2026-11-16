import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const calls: Array<{ args: string[]; session?: string; profileDir?: string }> = [];
let openSessions: string[] = [];
vi.mock("../tools/browser-tools.js", () => ({
  execBrowserAsync: vi.fn(async (args: string[], options: { session?: string; profileDir?: string } = {}) => {
    calls.push({ args, session: options.session, profileDir: options.profileDir });
    if (args[0] === "session") return { success: true, data: { sessions: openSessions }, raw: "" };
    if (args[0] === "close") return { success: openSessions.includes(options.session ?? ""), raw: "" };
    return { success: true, data: {}, raw: "" };
  }),
}));

import { clearBrowserProfile, finishProfileLogin, listBrowserProfiles, startProfileLogin } from "../tools/browser-profiles.js";
import { browserProfileRoutes } from "../server/routes/browser-profiles.js";

let polpoDir: string;
const agents = [
  { name: "growth", allowedTools: ["browser_*", "read"] },
  { name: "outreach", browserProfile: "growth", allowedTools: ["browser_navigate"] },
  { name: "writer", allowedTools: ["read", "write"] },
  { name: "scout", browserProfile: "scout-x" },
];
beforeEach(() => {
  polpoDir = mkdtempSync(join(tmpdir(), "polpo-profiles-"));
  calls.length = 0;
  openSessions = [];
  const growth = join(polpoDir, "browser-profiles", "growth", "Default");
  mkdirSync(growth, { recursive: true });
  writeFileSync(join(growth, "Cookies"), Buffer.alloc(2048));
  mkdirSync(join(polpoDir, "browser-profiles", "orchestrator"), { recursive: true });
  writeFileSync(join(polpoDir, "browser-profiles", "orchestrator", "Preferences"), "{}");
});
afterEach(() => rmSync(polpoDir, { recursive: true, force: true }));

describe("browser profiles", () => {
  it("lists folders and the profiles agents with browser tools are assigned to", async () => {
    openSessions = ["login-growth"];
    const profiles = await listBrowserProfiles(polpoDir, agents);
    expect(profiles.map((p) => p.name)).toEqual(["growth", "orchestrator", "scout-x"]);
    expect(profiles[0]).toMatchObject({ agents: ["growth", "outreach"], exists: true, hasCookies: true, loginOpen: true });
    expect(profiles[0]!.sizeBytes).toBeGreaterThanOrEqual(2048);
    expect(profiles[0]!.lastUsedAt).toMatch(/^\d{4}-/);
    expect(profiles[1]).toMatchObject({ agents: ["Polpo"], exists: true, hasCookies: false, loginOpen: false });
    // assigned but never opened; "writer" has no browser tools, so no profile
    expect(profiles[2]).toMatchObject({ agents: ["scout"], exists: false, sizeBytes: 0 });
  });

  it("a login opens the profile in its own session, and finishing closes it", async () => {
    const started = await startProfileLogin(polpoDir, "growth", "https://x.com/login");
    expect(started).toEqual({ session: "login-growth", profileDir: join(polpoDir, "browser-profiles", "growth") });
    expect(calls.at(-1)).toEqual({ args: ["open", "https://x.com/login"], session: "login-growth", profileDir: join(polpoDir, "browser-profiles", "growth") });
    openSessions = ["login-growth"];
    expect(await finishProfileLogin("growth")).toBe(true);
    expect(calls.at(-1)).toMatchObject({ args: ["close"], session: "login-growth" });
    await expect(startProfileLogin(polpoDir, "growth", "file:///etc/passwd")).rejects.toThrow();
    await expect(startProfileLogin(polpoDir, "../etc", "https://x.com")).rejects.toThrow(/Invalid profile name/);
  });

  it("clearing closes the sessions writing into the profile, then deletes it", async () => {
    openSessions = ["login-growth", "outreach", "unrelated"];
    const result = await clearBrowserProfile(polpoDir, "growth", agents);
    expect(result).toEqual({ deleted: true, closedSessions: ["login-growth", "outreach"] });
    expect(calls.filter((c) => c.args[0] === "close").map((c) => c.session)).toEqual(["login-growth", "outreach"]);
    expect(existsSync(join(polpoDir, "browser-profiles", "growth"))).toBe(false);
    expect(existsSync(join(polpoDir, "browser-profiles", "orchestrator"))).toBe(true);
    openSessions = [];
    expect(await clearBrowserProfile(polpoDir, "growth", agents)).toEqual({ deleted: false, closedSessions: [] });
    await expect(clearBrowserProfile(polpoDir, "..", agents)).rejects.toThrow(/Invalid profile name/);
  });

  it("routes: list, login, finish, delete", async () => {
    const app = browserProfileRoutes({ polpoDir: () => polpoDir, agents: async () => agents });
    const list = await (await app.request("/")).json();
    expect(list.data.profiles.map((p: { name: string }) => p.name)).toEqual(["growth", "orchestrator", "scout-x"]);
    expect((await app.request("/growth/login", { method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" } })).status).toBe(400);
    const login = await app.request("/growth/login", { method: "POST", body: JSON.stringify({ url: "https://x.com/login" }), headers: { "content-type": "application/json" } });
    expect((await login.json()).data.session).toBe("login-growth");
    expect((await (await app.request("/growth/login/finish", { method: "POST" })).json()).data).toEqual({ closed: false });
    expect((await (await app.request("/growth", { method: "DELETE" })).json()).data.deleted).toBe(true);
    expect((await app.request("/bad.name", { method: "DELETE" })).status).toBe(400);
  });
});
