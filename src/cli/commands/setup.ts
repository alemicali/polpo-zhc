import { resolve, basename, join } from "node:path";
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import readline from "node:readline";
import chalk from "chalk";
import type { Command } from "commander";
import { loadPolpoConfig, savePolpoConfig, generatePolpoConfigDefault } from "../../core/config.js";
import { PROVIDER_ENV_MAP, listModels } from "../../llm/pi-client.js";
import type { ModelInfo } from "../../llm/pi-client.js";

// ── Readline helpers ────────────────────────────────

function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptWithDefault(label: string, defaultVal: string): Promise<string> {
  const answer = await promptUser(`  ${label} ${chalk.dim(`[${defaultVal}]`)}: `);
  return answer || defaultVal;
}

async function pickFromList(items: string[], prompt: string): Promise<number> {
  for (let i = 0; i < items.length; i++) {
    console.log(`  ${chalk.cyan(`${i + 1}.`)} ${items[i]}`);
  }
  console.log();
  const answer = await promptUser(`  ${prompt}: `);
  const idx = parseInt(answer, 10) - 1;
  if (idx < 0 || idx >= items.length) return -1;
  return idx;
}

// ── Provider detection ──────────────────────────────

interface DetectedProvider {
  name: string;
  source: "env" | "oauth";
  envVar?: string;
}

function detectProviders(): DetectedProvider[] {
  const detected: DetectedProvider[] = [];

  for (const [provider, envVar] of Object.entries(PROVIDER_ENV_MAP)) {
    if (process.env[envVar]) {
      detected.push({ name: provider, source: "env", envVar });
    }
  }

  try {
    const { hasOAuthProfiles } = require("../../llm/pi-client.js");
    if (typeof hasOAuthProfiles === "function") {
      for (const provider of Object.keys(PROVIDER_ENV_MAP)) {
        if (!detected.find((d) => d.name === provider) && hasOAuthProfiles(provider)) {
          detected.push({ name: provider, source: "oauth" });
        }
      }
    }
  } catch {
    // OAuth check unavailable
  }

  return detected;
}

// ── Model helpers ───────────────────────────────────

function fmtCost(cost: number): string {
  if (cost === 0) return "free";
  if (cost < 1) return `$${cost.toFixed(2)}/M`;
  return `$${cost.toFixed(0)}/M`;
}

function modelLabel(m: ModelInfo): string {
  const tags: string[] = [];
  if (m.reasoning) tags.push("reasoning");
  if (m.cost.input === 0 && m.cost.output === 0) tags.push("free");
  const costStr = m.cost.input > 0 ? `in:${fmtCost(m.cost.input)} out:${fmtCost(m.cost.output)}` : "";
  const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
  return `${m.name}${tagStr}${costStr ? ` ${chalk.dim(costStr)}` : ""}`;
}

function getProviderModels(provider: string): ModelInfo[] {
  return listModels(provider).sort((a, b) => a.cost.input - b.cost.input);
}

// ── .env persistence ────────────────────────────────

function persistToEnvFile(polpoDir: string, envVar: string, value: string): void {
  const envPath = join(polpoDir, ".env");
  if (!existsSync(polpoDir)) mkdirSync(polpoDir, { recursive: true });

  let content = "";
  if (existsSync(envPath)) {
    content = readFileSync(envPath, "utf-8");
    const regex = new RegExp(`^${envVar}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${envVar}=${value}`);
      writeFileSync(envPath, content, "utf-8");
      try { chmodSync(envPath, 0o600); } catch { /* best-effort */ }
      return;
    }
  }

  const line = `${envVar}=${value}\n`;
  writeFileSync(envPath, content ? `${content.trimEnd()}\n${line}` : line, "utf-8");
  try { chmodSync(envPath, 0o600); } catch { /* best-effort */ }
}

// ── OAuth login (inline) ────────────────────────────

async function runOAuthLogin(provider: string): Promise<boolean> {
  try {
    const { oauthLogin, OAUTH_PROVIDERS } = await import("../../auth/index.js");
    type OAuthProviderName = (typeof OAUTH_PROVIDERS)[number]["id"];

    const match = OAUTH_PROVIDERS.find((p: { id: string }) => p.id === provider);
    if (!match) return false;

    console.log();
    console.log(chalk.bold(`  Logging in to ${match.name}...`));
    console.log();

    const profileId = await oauthLogin(provider as OAuthProviderName, {
      onAuthUrl: (url: string, instructions?: string) => {
        if (instructions) console.log(chalk.yellow(`  ${instructions}`));
        console.log(`  ${chalk.bold("Open this URL in your browser:")}`);
        console.log(`  ${chalk.cyan(url)}`);
        console.log();
      },
      onPrompt: async (message: string, placeholder?: string) => {
        return promptUser(`  ${message}${placeholder ? chalk.dim(` (${placeholder})`) : ""}: `);
      },
      onProgress: (message: string) => {
        console.log(chalk.dim(`  ${message}`));
      },
    });

    console.log(`  ${chalk.green("Login successful!")} Profile: ${chalk.bold(profileId)}`);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.log(`  ${chalk.red(`Login failed: ${msg}`)}`);
    return false;
  }
}

// ── Auth options ────────────────────────────────────

interface AuthOption {
  id: string;
  label: string;
  description: string;
  type: "oauth" | "api_key";
  oauthId?: string;
}

function getAuthOptions(): AuthOption[] {
  return [
    // Free OAuth
    { id: "google-antigravity", label: "Google Antigravity", description: "Free — Gemini 3, Claude, GPT-OSS via Google account", type: "oauth", oauthId: "google-antigravity" },
    { id: "google-gemini-cli", label: "Google Gemini CLI", description: "Free — Gemini models via Google account", type: "oauth", oauthId: "google-gemini-cli" },
    // Paid OAuth
    { id: "anthropic", label: "Anthropic (Claude Pro/Max)", description: "Requires Claude Pro or Max subscription", type: "oauth", oauthId: "anthropic" },
    { id: "openai-codex", label: "OpenAI Codex (ChatGPT Plus/Pro)", description: "Requires ChatGPT Plus or Pro subscription", type: "oauth", oauthId: "openai-codex" },
    { id: "github-copilot", label: "GitHub Copilot", description: "Requires Copilot subscription — multi-model access", type: "oauth", oauthId: "github-copilot" },
    // Manual
    { id: "api-key", label: "Enter an API key manually", description: "For any provider (OpenAI, Anthropic, Groq, etc.)", type: "api_key" },
  ];
}

// ── Auth step ───────────────────────────────────────

async function runAuthStep(providers: DetectedProvider[], polpoDir: string): Promise<void> {
  const authOptions = getAuthOptions();
  const labels = [
    ...authOptions.map((a) => {
      const tag = a.type === "oauth"
        ? (a.description.startsWith("Free") ? chalk.green("FREE") : chalk.yellow("PAID"))
        : chalk.dim("MANUAL");
      return `${tag} ${chalk.bold(a.label)} ${chalk.dim(`— ${a.description}`)}`;
    }),
    chalk.dim("Skip"),
  ];

  const authIdx = await pickFromList(labels, `Select (1-${labels.length})`);
  if (authIdx < 0 || authIdx >= authOptions.length) return;

  const selected = authOptions[authIdx];

  if (selected.type === "oauth" && selected.oauthId) {
    const success = await runOAuthLogin(selected.oauthId);
    if (success) {
      // Re-detect after successful login
      for (const p of detectProviders()) {
        if (!providers.find((e) => e.name === p.name)) providers.push(p);
      }
    }
  } else if (selected.type === "api_key") {
    console.log();
    console.log(chalk.bold("  Select a provider:"));
    console.log();
    const allProviders = Object.entries(PROVIDER_ENV_MAP)
      .filter(([, envVar], idx, arr) => arr.findIndex(([, ev]) => ev === envVar) === idx);
    const pIdx = await pickFromList(
      allProviders.map(([p, ev]) => `${chalk.bold(p)} ${chalk.dim(`(${ev})`)}`),
      `Select (1-${allProviders.length})`,
    );

    if (pIdx >= 0) {
      const [provider, envVar] = allProviders[pIdx];
      const key = await promptUser(`  ${envVar}: `);
      if (key) {
        process.env[envVar] = key;
        persistToEnvFile(polpoDir, envVar, key);
        console.log(chalk.green(`  ✓ ${envVar} saved to .polpo/.env`));
        providers.push({ name: provider, source: "env", envVar });
      }
    }
  }
}

// ── Setup wizard ────────────────────────────────────

export interface SetupOptions {
  polpoDir?: string;
  workDir?: string;
  nonInteractive?: boolean;
}

export async function runSetupWizard(options?: SetupOptions): Promise<void> {
  const workDir = options?.workDir ?? process.cwd();
  const polpoDir = options?.polpoDir ?? resolve(workDir, ".polpo");
  const isInteractive = !options?.nonInteractive && process.stdin.isTTY;
  const existing = loadPolpoConfig(polpoDir);
  const orgName = existing?.org ?? basename(workDir);

  console.log();
  console.log(chalk.bold("  Polpo Setup"));
  console.log();

  // ── Non-interactive fallback ──
  if (!isInteractive) {
    const model = process.env.POLPO_MODEL;
    const config = generatePolpoConfigDefault(orgName, { model: model ?? undefined });
    savePolpoConfig(polpoDir, config);
    if (!model) {
      console.log(chalk.yellow("  No model configured. Set POLPO_MODEL or run 'polpo setup' interactively."));
    } else {
      console.log(chalk.green(`  Config saved with model: ${model}`));
    }
    return;
  }

  // ── Step 1: Auth ──────────────────────────────────
  const providers = detectProviders();

  if (providers.length > 0) {
    console.log(chalk.dim("  Detected providers:"));
    for (const p of providers) {
      const source = p.source === "env" ? `env: ${p.envVar}` : "OAuth profile";
      console.log(`  ${chalk.green("✓")} ${chalk.bold(p.name)} ${chalk.dim(`(${source})`)}`);
    }
    console.log();
  } else {
    console.log(chalk.bold("  Step 1 — Auth with a provider"));
    console.log();
    await runAuthStep(providers, polpoDir);
    console.log();
  }

  // If still no providers after auth step, bail early with guidance
  if (providers.length === 0) {
    console.log(chalk.yellow("  No provider configured."));
    console.log(chalk.dim("  Run 'polpo setup' again or 'polpo auth login' to add one."));
    console.log();
    // Still save a config so the directory is initialized
    savePolpoConfig(polpoDir, generatePolpoConfigDefault(orgName));
    return;
  }

  // ── Step 2: Orchestrator model ────────────────────
  console.log(chalk.bold("  Step 2 — Select the orchestrator model"));
  console.log();

  let selectedModel: string | undefined;
  const allModels: { spec: string; label: string }[] = [];
  for (const p of providers) {
    for (const m of getProviderModels(p.name)) {
      allModels.push({ spec: `${p.name}:${m.id}`, label: modelLabel(m) });
    }
  }

  if (allModels.length > 0) {
    const capped = allModels.slice(0, 15);
    const labels = [
      ...capped.map((m) => `${chalk.bold(m.spec)} ${chalk.dim(`— ${m.label}`)}`),
      chalk.dim("Enter custom model"),
    ];

    const idx = await pickFromList(labels, `Select (1-${labels.length})`);
    if (idx >= 0 && idx < capped.length) {
      selectedModel = capped[idx].spec;
    } else {
      const custom = await promptUser("  Model spec (provider:model): ");
      if (custom) selectedModel = custom;
    }
  } else {
    const custom = await promptUser("  Model spec (provider:model): ");
    if (custom) selectedModel = custom;
  }

  if (!selectedModel) {
    console.log(chalk.yellow("  No model selected. You can set it later in .polpo/polpo.json"));
    console.log();
  }

  // ── Step 3: First agent ───────────────────────────
  console.log();
  console.log(chalk.bold("  Step 3 — First agent"));
  console.log();

  const defaultAgentName = existing?.teams?.[0]?.agents?.[0]?.name ?? "agent-1";
  const defaultAgentRole = existing?.teams?.[0]?.agents?.[0]?.role ?? "founder";

  const agentName = await promptWithDefault("Agent name", defaultAgentName);
  const agentRole = await promptWithDefault("Agent role", defaultAgentRole);

  // ── Write config ──────────────────────────────────
  const config = generatePolpoConfigDefault(orgName, {
    model: selectedModel,
    agentName,
    agentRole,
  });
  savePolpoConfig(polpoDir, config);

  // ── Summary ──
  console.log();
  console.log(chalk.green("  Ready!"));
  console.log();
  console.log(`  ${chalk.dim("Org:")}    ${orgName}`);
  console.log(`  ${chalk.dim("Model:")}  ${selectedModel ?? chalk.yellow("not set")}`);
  console.log(`  ${chalk.dim("Agent:")}  ${agentName} (${agentRole})`);
  console.log();
  console.log(chalk.dim("  Config saved to .polpo/polpo.json"));
  console.log(chalk.dim("  Run: polpo tui"));
  console.log();
}

// ── CLI command registration ────────────────────────

export function registerSetupCommand(parent: Command): void {
  parent
    .command("setup")
    .description("Interactive setup wizard — auth, model, and first agent")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (opts) => {
      const workDir = resolve(opts.dir);
      await runSetupWizard({ workDir });
    });
}
