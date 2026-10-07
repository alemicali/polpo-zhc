/**
 * env_from_vault: vault secrets as environment variables of one bash command, masked in its
 * output, and vault_get without secret values in sandboxed runs.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveSandbox } from "@polpo-ai/core/sandbox";
import { EncryptedVaultStore } from "../vault/encrypted-store.js";
import { resolveAgentVault, loadAgentVaultEntries, type ResolvedVault } from "../vault/resolver.js";
import {
  createSecretMasker, invalidEnvVarName, isNonSecretVaultField, resolveEnvFromVault, secretVariants,
} from "../vault/env-from-vault.js";
import { createSystemTools } from "../tools/system-tools.js";
import { createVaultToolsCore } from "../tools/vault-tools.js";
import { BwrapWorkspace, bwrapAvailable } from "../sandbox/workspaces.js";
import { WorkspaceShell } from "../sandbox/manager.js";

// Distinct encodings: "/", "+", "=", ":" and a space change under base64 and URL encoding.
const TOKEN = "ghp_Secret/Value+42=x:y z";
const NPM_TOKEN = "npm_shared_token_0123456789";
const SHORT = "abc12";

const previousKey = process.env.POLPO_VAULT_KEY;
let polpoDir: string;
let vault: ResolvedVault;

beforeAll(async () => {
  process.env.POLPO_VAULT_KEY = randomBytes(32).toString("hex");
  polpoDir = mkdtempSync(join(tmpdir(), "polpo-envvault-"));
  const store = new EncryptedVaultStore(polpoDir);
  await store.set("alice", "github", { type: "api_key", label: "GitHub bot", credentials: { token: TOKEN, user: "alice-bot", pin: SHORT } });
  await store.set("alice", "api.example.com", { type: "custom", credentials: { key: "dotted-service-secret" } });
  await store.set("alice", "smtp", { type: "smtp", credentials: { host: "smtp.example.com", port: "587", user: "mailer", pass: "smtp-password-xyz", from: "bot@example.com" } });
  await store.set("alice", "db", { type: "custom", credentials: { url: "postgres://app:db-pass-123@db.example.com/app", endpoint: "https://api.example.com", region: "eu-west-1" } });
  // bob shares "npm" with alice; carol keeps "private" to herself
  await store.set("bob", "npm", { type: "api_key", allowedAgents: ["alice"], credentials: { token: NPM_TOKEN } });
  await store.set("carol", "private", { type: "api_key", credentials: { token: "carol-only-secret" } });
  vault = resolveAgentVault(await loadAgentVaultEntries(store, "alice"));
});

afterAll(() => {
  rmSync(polpoDir, { recursive: true, force: true });
  if (previousKey === undefined) delete process.env.POLPO_VAULT_KEY; else process.env.POLPO_VAULT_KEY = previousKey;
});

const textOf = (r: any): string => r.content.map((c: any) => c.text ?? "").join("");

describe("resolving env_from_vault", () => {
  test("own and shared entries, string and object references", () => {
    const r = resolveEnvFromVault({ GH_TOKEN: "github.token", NPM_TOKEN: { service: "npm", key: "token" }, API_KEY: "api.example.com.key" }, vault);
    expect(r.errors).toEqual([]);
    expect(r.env).toEqual({ GH_TOKEN: TOKEN, NPM_TOKEN, API_KEY: "dotted-service-secret" });
    expect(r.refs).toEqual({ GH_TOKEN: "github.token", NPM_TOKEN: "npm.token", API_KEY: "api.example.com.key" });
  });

  test("unknown entries and keys are reported without values, and nothing is resolved", () => {
    const r = resolveEnvFromVault({ A: "private.token", B: "github.nope", C: "github.token", D: "nodot" }, vault);
    expect(r.env).toEqual({});
    expect(r.secrets).toEqual([]);
    const all = r.errors.join("\n");
    expect(all).toContain('A: no vault entry for "private.token"');
    expect(all).toContain('B: vault entry "github" has no key "nope" (keys: token, user, pin)');
    expect(all).toContain('invalid reference "nodot"');
    expect(all).toContain("available vault entries:");
    expect(all).not.toContain("private,"); // carol's entry is not reachable, not even by name
    for (const secret of [TOKEN, NPM_TOKEN, "carol-only-secret", SHORT]) expect(all).not.toContain(secret);
  });

  test("variable names", () => {
    for (const ok of ["GITHUB_TOKEN", "_X", "A1"]) expect(invalidEnvVarName(ok)).toBeUndefined();
    for (const bad of ["github_token", "1ABC", "A-B", "", "PATH", "HOME", "LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV"]) {
      expect(invalidEnvVarName(bad)).toBeDefined();
    }
    const r = resolveEnvFromVault({ PATH: "github.token", lower: "github.token" }, vault);
    expect(r.errors).toHaveLength(2);
    expect(r.env).toEqual({});
  });

  test("no vault", () => {
    expect(resolveEnvFromVault({ A: "github.token" }, undefined).errors[0]).toContain("no vault entries");
    expect(resolveEnvFromVault(undefined, undefined)).toEqual({ env: {}, secrets: [], refs: {}, errors: [] });
  });
});

describe("masking", () => {
  test("plain, base64 and URL-encoded values; short values are left alone", () => {
    const mask = createSecretMasker([TOKEN, SHORT]);
    const b64 = Buffer.from(TOKEN).toString("base64");
    const b64nl = Buffer.from(`${TOKEN}\n`).toString("base64");
    const text = [TOKEN, b64, b64.replace(/=+$/, ""), b64nl, Buffer.from(TOKEN).toString("base64url"), encodeURIComponent(TOKEN), SHORT].join("|");
    const out = mask(text);
    expect(out).toBe(["***", "***", "***", "***", "***", "***", SHORT].join("|"));
    expect(secretVariants(SHORT)).toEqual([]);
  });

  test("long values wrapped by base64 at 76 columns", () => {
    const long = "x".repeat(80) + "-secret";
    const wrapped = Buffer.from(long).toString("base64").match(/.{1,76}/g)!.join("\n");
    expect(createSecretMasker([long])(`out:${wrapped}\n`)).toBe("out:***\n");
  });
});

describe("vault_get", () => {
  const get = async (sandboxProvider?: string, service = "github") => {
    const tool = createVaultToolsCore(vault, { sandboxProvider }).find((t) => t.name === "vault_get")!;
    return tool.execute("t1", { service } as any);
  };

  test("sandboxed runs: type, label, keys and non-secret fields, never secret values", async () => {
    for (const provider of ["bwrap", "docker", "daytona", "e2b"]) {
      const r = await get(provider);
      const text = textOf(r);
      expect(text).toContain('Vault entry "github" (api_key, label: GitHub bot)');
      expect(text).toContain("user: alice-bot");
      expect(text).toContain("token: ***");
      expect(text).toContain("pin: ***");
      expect(text).toContain('"GITHUB_TOKEN": "github.token"');
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(SHORT);
      expect(JSON.stringify(r.details)).not.toContain(TOKEN);
      expect((r.details as any).secretsHidden).toBe(true);
    }
    const smtp = textOf(await get("bwrap", "smtp"));
    expect(smtp).toContain("host: smtp.example.com");
    expect(smtp).toContain("port: 587");
    expect(smtp).toContain("from: bot@example.com");
    expect(smtp).toContain("pass: ***");
    expect(smtp).not.toContain("smtp-password-xyz");
    const db = textOf(await get("bwrap", "db"));
    expect(db).toContain("url: ***"); // credentials inside the URL
    expect(db).not.toContain("db-pass-123");
    expect(db).toContain("endpoint: https://api.example.com");
    expect(db).toContain("region: eu-west-1");
    // shared entries follow the same rule
    expect(textOf(await get("bwrap", "npm"))).not.toContain(NPM_TOKEN);
  });

  test("local (or no sandbox): values as before", async () => {
    for (const provider of ["local", undefined]) {
      const text = textOf(await get(provider));
      expect(text).toContain(`token: ${TOKEN}`);
      expect(text).toContain(`pin: ${SHORT}`);
    }
  });

  test("createSystemTools passes the provider to the vault tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "polpo-envvault-sys-"));
    try {
      const sandboxed = createSystemTools(root, undefined, undefined, undefined, vault, undefined, undefined, { sandboxProvider: "bwrap" });
      const local = createSystemTools(root, undefined, undefined, undefined, vault, undefined, undefined, { sandboxProvider: "local" });
      const run = (tools: any[]) => tools.find((t) => t.name === "vault_get").execute("t", { service: "github" });
      expect(textOf(await run(sandboxed))).not.toContain(TOKEN);
      expect(textOf(await run(local))).toContain(TOKEN);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("non-secret fields", () => {
    expect(isNonSecretVaultField("Host", "x")).toBe(true);
    expect(isNonSecretVaultField("password", "x")).toBe(false);
    expect(isNonSecretVaultField("url", "https://h/x?api_key=1")).toBe(false);
    expect(isNonSecretVaultField("url", "https://h/x?page=1")).toBe(true);
  });
});

describe("bash with env_from_vault on the host (no sandbox)", () => {
  test("the variable reaches the command and is masked", async () => {
    const root = mkdtempSync(join(tmpdir(), "polpo-envvault-local-"));
    try {
      const bash = createSystemTools(root, ["bash"], undefined, undefined, vault).find((t) => t.name === "bash")!;
      const r = await bash.execute("t", { command: 'echo "v=$NPM_TOKEN"; echo "len=${#NPM_TOKEN}"', env_from_vault: { NPM_TOKEN: "npm.token" } } as any);
      expect(textOf(r)).toContain("v=***");
      expect(textOf(r)).toContain(`len=${NPM_TOKEN.length}`);
      expect(textOf(r)).not.toContain(NPM_TOKEN);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

const bwrapSandbox: EffectiveSandbox = { provider: "bwrap", network: { mode: "deny" }, resources: {}, providerOptions: {}, denied: [] };

describe.skipIf(!bwrapAvailable())("bash with env_from_vault in bubblewrap", () => {
  let root: string;
  let outDir: string;
  let ws: BwrapWorkspace;
  let bash: any;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "polpo-envvault-bwrap-"));
    outDir = mkdtempSync(join(tmpdir(), "polpo-envvault-out-"));
    ws = new BwrapWorkspace({ root, sandbox: bwrapSandbox });
    bash = createSystemTools(root, ["bash"], undefined, undefined, vault, undefined, new WorkspaceShell(ws), { sandboxProvider: "bwrap", toolOutputDir: outDir })
      .find((t) => t.name === "bash");
  });
  afterAll(async () => {
    await ws.dispose();
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  const leaks = (text: string) => [
    TOKEN, Buffer.from(TOKEN).toString("base64"), Buffer.from(`${TOKEN}\n`).toString("base64"), encodeURIComponent(TOKEN),
  ].filter((v) => text.includes(v));

  test("the value reaches the jailed command and is masked in plain, base64 and URL-encoded output", async () => {
    const sha = createHash("sha256").update(TOKEN).digest("hex");
    const command = [
      'echo "plain=$GH_TOKEN"',
      'printf %s "$GH_TOKEN" | base64',
      'echo "$GH_TOKEN" | base64',
      `python3 -c 'import os, urllib.parse; print(urllib.parse.quote(os.environ["GH_TOKEN"], safe=""))'`,
      'printf %s "$GH_TOKEN" | sha256sum',
      'echo "err=$GH_TOKEN" >&2',
      'echo "files=$(ls -A | wc -l)"',
    ].join("; ");
    const r = await bash.execute("t1", { command, env_from_vault: { GH_TOKEN: "github.token" } });
    const text = textOf(r);
    expect(text).toContain("Exit code: 0");
    expect(text).toContain(sha); // the command saw the exact value
    expect(text).toContain("plain=***");
    expect(text).toContain("err=***");
    expect(text).toContain("files=0"); // nothing written to the working directory
    expect(text.match(/\*\*\*/g)!.length).toBeGreaterThanOrEqual(5);
    expect(leaks(text)).toEqual([]);
    // details keep only the references
    expect(r.details.envFromVault).toEqual({ GH_TOKEN: "github.token" });
    expect(leaks(JSON.stringify(r.details))).toEqual([]);
  });

  test("the variable exists for that command only", async () => {
    await bash.execute("t2", { command: "true", env_from_vault: { GH_TOKEN: "github.token" } });
    const r = await bash.execute("t3", { command: 'echo "x=${GH_TOKEN:-unset}"' });
    expect(textOf(r)).toContain("x=unset");
  });

  test("offloaded output is masked too", async () => {
    const command = 'for i in $(seq 1 3000); do echo "line $i padding padding padding"; done; echo "tail=$GH_TOKEN"';
    const r = await bash.execute("t4", { command, env_from_vault: { GH_TOKEN: "github.token" } });
    expect(r.details.outputPath).toBeDefined();
    const saved = readFileSync(r.details.outputPath, "utf8");
    expect(saved).toContain("tail=***");
    expect(leaks(saved)).toEqual([]);
    expect(leaks(textOf(r))).toEqual([]);
  });

  test("bad references: clear errors without values, and the command does not run", async () => {
    const r = await bash.execute("t5", { command: "touch ran.txt", env_from_vault: { GH_TOKEN: "github.nope", PATH: "github.token", X: "private.token" } });
    const text = textOf(r);
    expect(text).toContain("env_from_vault:");
    expect(text).toContain('has no key "nope"');
    expect(text).toContain('"PATH" is reserved');
    expect(text).toContain('no vault entry for "private.token"');
    expect(text).toContain("The command was not run.");
    expect(existsSync(join(root, "ran.txt"))).toBe(false);
    expect(leaks(text + JSON.stringify(r.details))).toEqual([]);
  });
});

describe("agents are told about env_from_vault", () => {
  test("sandbox note and tool description", async () => {
    const { sandboxPromptNote } = await import("../adapters/engine.js");
    expect(sandboxPromptNote(bwrapSandbox, [])).toContain("env_from_vault");
    expect(sandboxPromptNote({ ...bwrapSandbox, provider: "local" }, [])).toBe("");
    const bash = createSystemTools("/tmp", ["bash"]).find((t) => t.name === "bash")!;
    expect(bash.description).toContain("env_from_vault");
    expect(JSON.stringify(bash.parameters)).toContain("env_from_vault");
  });
});
