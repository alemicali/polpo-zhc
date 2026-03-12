import { resolve, basename } from "node:path";
import readline from "node:readline";
import chalk from "chalk";
import type { Command } from "commander";
import { loadPolpoConfig, savePolpoConfig, generatePolpoConfigDefault } from "../../core/config.js";
import { PROVIDER_ENV_MAP } from "../../llm/pi-client.js";
import {
  detectProviders,
  persistToEnvFile,
  getAuthOptions,
  startOAuthLogin,
  getProviderModels,
  modelLabel as rawModelLabel,
  type DetectedProvider,
  type ModelInfo,
} from "../../setup/index.js";

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

// ── Chalk model label ──────────────────────────────

function modelLabel(m: ModelInfo): string {
  const { name, tags, costStr } = rawModelLabel(m);
  const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
  return `${name}${tagStr}${costStr ? ` ${chalk.dim(costStr)}` : ""}`;
}

// ── OAuth login (CLI adapter) ──────────────────────

async function runOAuthLogin(provider: string): Promise<boolean> {
  try {
    console.log();
    console.log(chalk.bold(`  Logging in...`));
    console.log();

    await startOAuthLogin(provider, {
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

    console.log(`  ${chalk.green("Login successful!")}`);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.log(`  ${chalk.red(`Login failed: ${msg}`)}`);
    return false;
  }
}

// ── Auth step ───────────────────────────────────────

async function runAuthStep(providers: DetectedProvider[], polpoDir: string): Promise<void> {
  const authOptions = getAuthOptions();
  const labels = [
    ...authOptions.map((a) => {
      const tag = a.type === "oauth"
        ? (a.free ? chalk.green("FREE") : chalk.yellow("PAID"))
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
        providers.push({ name: provider, source: "env", envVar, hasKey: true });
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
    const config = generatePolpoConfigDefault(orgName, {
      model: model ?? undefined,
    });
    savePolpoConfig(polpoDir, config);
    if (!model) {
      console.log(chalk.yellow("  No model configured. Set POLPO_MODEL or run 'polpo setup' interactively."));
    } else {
      console.log(chalk.green(`  Config saved with model: ${model}`));
    }
    return;
  }

  // ── Step 1: Auth ──────────────────────────────────
  const providers = detectProviders().filter((p) => p.hasKey);

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
  console.log(chalk.dim("  Run: polpo serve"));
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
