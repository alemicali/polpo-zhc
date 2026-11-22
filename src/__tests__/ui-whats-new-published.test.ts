/**
 * ui/server.mjs records when each What's new entry first went online on this instance: the build
 * lists its entry ids in whats-new-ids.json; the server stores id → first-seen time in
 * <POLPO_UI_STATE_DIR>/whats-new.json (never changed afterwards) and inlines the times into
 * /runtime-config.js. The ids already there the very first time are recorded without a time.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../../ui/server.mjs", import.meta.url));
const dirs: string[] = [];
const uis: ChildProcess[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function startUi(root: string, stateDir: string): Promise<{ base: string; child: ChildProcess }> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, [SERVER, "--root", root, "--port", String(port), "--host", "127.0.0.1"], {
    env: { ...process.env, POLPO_API_URL: "", POLPO_APPEARANCE_URL: "", POLPO_UI_STATE_DIR: stateDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  uis.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the UI server did not start")), 10_000);
    child.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("listening")) { clearTimeout(timer); resolve(); } });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`the UI server exited (${code})`)); });
  });
  return { base: `http://127.0.0.1:${port}`, child };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(); });
}

const runtimeConfig = async (base: string) => {
  const text = await (await fetch(`${base}/runtime-config.js`)).text();
  const sandbox: { __POLPO_RUNTIME_CONFIG__?: Record<string, unknown> } = {};
  new Function("globalThis", text)(sandbox);
  return sandbox.__POLPO_RUNTIME_CONFIG__!;
};

const readState = async (stateDir: string) =>
  JSON.parse(await readFile(join(stateDir, "whats-new.json"), "utf8")) as { version: number; firstSeen: Record<string, string | null> };

async function buildRoot(ids: string[]): Promise<string> {
  const root = await tempDir("polpo-ui-root-");
  await writeFile(join(root, "index.html"), "<!doctype html><title>Polpo</title>");
  await writeFile(join(root, "whats-new-ids.json"), JSON.stringify({ ids }));
  return root;
}

afterEach(async () => {
  await Promise.all(uis.splice(0).map(stop));
});

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("What's new: when entries went online", () => {
  it("seeds the entries already there the first time without a time (none is invented)", async () => {
    const root = await buildRoot(["2026-11-21-old", "2026-11-20-older"]);
    const stateDir = await tempDir("polpo-ui-state-");
    const { base } = await startUi(root, stateDir);
    expect(await readState(stateDir)).toEqual({ version: 1, firstSeen: { "2026-11-21-old": null, "2026-11-20-older": null } });
    expect((await runtimeConfig(base)).whatsNewPublishedAt).toBeUndefined();
  });

  it("gives a new entry the time it first went online, once, and never changes it", async () => {
    const stateDir = await tempDir("polpo-ui-state-");
    await writeFile(join(stateDir, "whats-new.json"), JSON.stringify({ version: 1, firstSeen: { "2026-11-21-old": null } }));
    const root = await buildRoot(["2026-11-22-new", "2026-11-21-old"]);

    const before = Date.now();
    const first = await startUi(root, stateDir);
    const recorded = (await readState(stateDir)).firstSeen;
    expect(recorded["2026-11-21-old"]).toBeNull();
    const at = recorded["2026-11-22-new"];
    expect(typeof at).toBe("string");
    expect(Date.parse(at!)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(at!)).toBeLessThanOrEqual(Date.now());
    // runtime-config.js carries only the entries of this build that have a time
    expect((await runtimeConfig(first.base)).whatsNewPublishedAt).toEqual({ "2026-11-22-new": at });
    await stop(first.child);

    // a restart (and a later deploy with one more entry) keeps the earlier time as it was
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(root, "whats-new-ids.json"), JSON.stringify({ ids: ["2026-11-23-newer", "2026-11-22-new", "2026-11-21-old"] }));
    const second = await startUi(root, stateDir);
    const again = (await readState(stateDir)).firstSeen;
    expect(again["2026-11-22-new"]).toBe(at);
    expect(again["2026-11-21-old"]).toBeNull();
    expect(Date.parse(again["2026-11-23-newer"]!)).toBeGreaterThan(Date.parse(at!));
    expect((await runtimeConfig(second.base)).whatsNewPublishedAt).toEqual({
      "2026-11-23-newer": again["2026-11-23-newer"],
      "2026-11-22-new": at,
    });
  });

  it("notices a rebuild without a restart, and keeps entries a build no longer lists", async () => {
    const stateDir = await tempDir("polpo-ui-state-");
    await writeFile(join(stateDir, "whats-new.json"), JSON.stringify({ version: 1, firstSeen: { gone: "2026-11-01T10:00:00.000Z" } }));
    const root = await buildRoot(["a"]);
    const { base } = await startUi(root, stateDir);
    const a = (await readState(stateDir)).firstSeen.a;
    await writeFile(join(root, "whats-new-ids.json"), JSON.stringify({ ids: ["b", "a", "../evil", 42] }));
    const published = (await runtimeConfig(base)).whatsNewPublishedAt as Record<string, string>;
    expect(Object.keys(published).sort()).toEqual(["a", "b"]);
    expect(published.a).toBe(a);
    const state = (await readState(stateDir)).firstSeen;
    expect(state.gone).toBe("2026-11-01T10:00:00.000Z");
    expect(Object.keys(state).sort()).toEqual(["a", "b", "gone"]);
  });

  it("never overwrites a state file it cannot read, and a build without the list records nothing", async () => {
    const stateDir = await tempDir("polpo-ui-state-");
    await writeFile(join(stateDir, "whats-new.json"), "{not json");
    const root = await buildRoot(["a"]);
    const { base } = await startUi(root, stateDir);
    expect((await runtimeConfig(base)).whatsNewPublishedAt).toBeUndefined();
    expect(await readFile(join(stateDir, "whats-new.json"), "utf8")).toBe("{not json");

    const plainRoot = await tempDir("polpo-ui-root-");
    await writeFile(join(plainRoot, "index.html"), "<!doctype html>");
    const emptyState = await tempDir("polpo-ui-state-");
    const plain = await startUi(plainRoot, emptyState);
    expect((await runtimeConfig(plain.base)).whatsNewPublishedAt).toBeUndefined();
    await expect(readFile(join(emptyState, "whats-new.json"), "utf8")).rejects.toThrow();
  });
});
