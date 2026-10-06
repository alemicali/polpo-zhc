import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = { stdout: "" };

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(cli.stdout, "utf-8"));
      child.emit("close", 0);
    });
    return child;
  }),
}));

import { createBrowserTools, execBrowserAsync } from "../tools/browser-tools.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "polpo-browser-offload-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function snapshotTool(dir: string) {
  return createBrowserTools(root, "agent-x", ["browser_snapshot"], undefined, dir)[0];
}

describe("browser tools offload", () => {
  it("small results are unchanged", async () => {
    cli.stdout = JSON.stringify({ success: true, data: { snapshot: "- button @e1" } });
    const r = await snapshotTool(join(root, "out")).execute("id", {} as any);
    expect((r.content[0] as any).text).toBe(JSON.stringify({ snapshot: "- button @e1" }, null, 2));
    expect(r.details).toEqual({ snapshot: "- button @e1" });
  });

  it("results above 50 KB are saved in full; details are shrunk", async () => {
    const snapshot = Array.from({ length: 3000 }, (_, i) => `- link "item ${i}" [ref=e${i}]`).join("\n");
    cli.stdout = JSON.stringify({ success: true, data: { snapshot } });
    const dir = join(root, "out");
    const r = await snapshotTool(dir).execute("id", {} as any);
    const text = (r.content[0] as any).text as string;
    expect(text.length).toBeLessThan(51_000);
    const path = r.details.outputPath as string;
    expect(path.startsWith(dir)).toBe(true);
    expect(text).toContain(`Full output saved to ${path}.`);
    // The parsed JSON (not a tail-truncated raw string) is what gets saved.
    expect(readFileSync(path, "utf-8")).toBe(JSON.stringify({ snapshot }, null, 2));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(r.details.snapshot).toBeUndefined();
  });

  it("orchestrator-side execBrowserAsync keeps its 50 KB tail truncation", async () => {
    cli.stdout = "x".repeat(60_000);
    const r = await execBrowserAsync(["snapshot"]);
    expect(r.raw.length).toBe(50_000 + "\n[truncated]".length);
  });
});
