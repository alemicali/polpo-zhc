/**
 * The reusable GitHub Action (.github/actions/polpo-test/action.yml): valid YAML, the inputs it
 * documents, and its script — run with a fake `npx` — builds the `polpo test` command from the
 * inputs, points the summary at the job summary, records the exit code and fails the step with it.
 */
import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const action = parse(readFileSync(new URL("../../.github/actions/polpo-test/action.yml", import.meta.url), "utf-8")) as {
  inputs: Record<string, { required?: boolean; default?: string }>;
  runs: { using: string; steps: Array<{ id?: string; shell?: string; run?: string; env?: Record<string, string> }> };
};

function runStep(inputs: Record<string, string>, exitCode: number) {
  const dir = mkdtempSync(join(tmpdir(), "polpo-action-"));
  try {
    const bin = join(dir, "bin");
    spawnSync("mkdir", [bin]);
    // a fake npx: prints its arguments, exits with the code asked
    writeFileSync(join(bin, "npx"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/args"\nexit ${exitCode}\n`);
    chmodSync(join(bin, "npx"), 0o755);
    const step = action.runs.steps.find((s) => s.id === "test")!;
    const value = (k: string) => inputs[k] ?? action.inputs[k]?.default ?? "";
    const env: Record<string, string> = { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: join(dir, "out"), GITHUB_STEP_SUMMARY: join(dir, "summary.md") };
    for (const [k, v] of Object.entries(step.env ?? {})) {
      const m = /^\$\{\{ inputs\.([\w-]+) \}\}$/.exec(v);
      env[k] = m ? value(m[1]!) : v;
    }
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run!], { env, encoding: "utf-8" });
    let args: string[] = [];
    try { args = readFileSync(join(dir, "args"), "utf-8").trim().split("\n"); } catch { /* npx not reached */ }
    return { status: r.status, args, output: readFileSync(join(dir, "out"), "utf-8"), summary: join(dir, "summary.md"), stderr: r.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("the polpo-test GitHub Action", () => {
  it("is a composite action with the documented inputs", () => {
    expect(action.runs.using).toBe("composite");
    expect(Object.keys(action.inputs)).toEqual(expect.arrayContaining(["url", "token", "agent", "suite", "version", "mode", "mcp-server", "mission", "fail-on-regression", "allow-real-tools", "junit", "timeout", "polpo-version"]));
    expect(action.inputs.url!.required).toBe(true);
    expect(action.inputs.token!.required).toBe(true);
    expect(action.inputs["fail-on-regression"]!.default).toBe("true");
  });

  it("runs polpo test on the instance with the inputs, writes the job summary and passes the exit code on", () => {
    const ok = runStep({ url: "https://polpo.example.com", token: "k", agent: "shop", version: "draft", "polpo-version": "0.7.1" }, 0);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.args).toEqual(["--yes", "polpo-ai@0.7.1", "test", "shop", "--version", "draft", "--fail-on-regression",
      "--remote", "https://polpo.example.com", "--junit", "polpo-suites.xml", "--summary", ok.summary, "--timeout", "1800"]);
    expect(ok.output).toContain("exit-code=0");

    const failed = runStep({ url: "https://polpo.example.com", token: "k", "mcp-server": "stock-api", suite: "saved-tests", "fail-on-regression": "false", mode: "all" }, 1);
    expect(failed.status).toBe(1);
    expect(failed.output).toContain("exit-code=1");
    expect(failed.args).toEqual(["--yes", "polpo-ai@latest", "test", "--suite", "saved-tests", "--mode", "all", "--mcp-server", "stock-api",
      "--remote", "https://polpo.example.com", "--junit", "polpo-suites.xml", "--summary", failed.summary, "--timeout", "1800"]);
  });
});
