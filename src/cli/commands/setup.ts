import { resolve, basename } from "node:path";
import readline from "node:readline";
import chalk from "chalk";
import type { Command } from "commander";
import { loadPolpoConfig, savePolpoConfig, generatePolpoConfigDefault } from "../../core/config.js";
import { PROVIDER_ENV_MAP } from "../../llm/pi-client.js";

// ── Recommended models per provider (shown in picker) ──

const RECOMMENDED_MODELS: Record<string, { spec: string; label: string }[]> = {
  anthropic: [
    { spec: "anthropic:claude-sonnet-4-6", label: "Claude Sonnet 4.6 (latest, balanced)" },
    { spec: "anthropic:claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5 (balanced)" },
    { spec: "anthropic:claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fast)" },
  ],
  openai: [
    { spec: "openai:gpt-4o", label: "GPT-4o (balanced)" },
    { spec: "openai:o4-mini", label: "o4-mini (reasoning, fast)" },
    { spec: "openai:gpt-4o-mini", label: "GPT-4o Mini (fast)" },
  ],
  google: [
    { spec: "google:gemini-2.5-flash", label: "Gemini 2.5 Flash (fast)" },
    { spec: "google:gemini-2.5-pro", label: "Gemini 2.5 Pro (balanced)" },
  ],
  groq: [
    { spec: "groq:llama-3.3-70b-versatile", label: "Llama 3.3 70B (free tier)" },
  ],
  mistral: [
    { spec: "mistral:codestral-latest", label: "Codestral (coding)" },
    { spec: "mistral:mistral-large-latest", label: "Mistral Large (flagship)" },
  ],
  xai: [
    { spec: "xai:grok-3", label: "Grok 3 (flagship)" },
    { spec: "xai:grok-3-mini", label: "Grok 3 Mini (fast)" },
  ],
  openrouter: [
    { spec: "openrouter:deepseek-chat", label: "DeepSeek Chat" },
  ],
  opencode: [
    { spec: "opencode:big-pickle", label: "Big Pickle (free)" },
  ],
};

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

  // Check env vars
  for (const [provider, envVar] of Object.entries(PROVIDER_ENV_MAP)) {
    if (process.env[envVar]) {
      detected.push({ name: provider, source: "env", envVar });
    }
  }

  // Check OAuth profiles (sync — just check file existence)
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
    // OAuth check unavailable — skip
  }

  return detected;
}

// ── Setup wizard ────────────────────────────────────

export interface SetupOptions {
  polpoDir?: string;
  nonInteractive?: boolean;
}

export async function runSetupWizard(options?: SetupOptions): Promise<void> {
  const cwd = process.cwd();
  const polpoDir = options?.polpoDir ?? resolve(cwd, ".polpo");
  const isInteractive = !options?.nonInteractive && process.stdin.isTTY;

  // Load existing config for defaults
  const existing = loadPolpoConfig(polpoDir);

  console.log();
  console.log(chalk.bold("  Polpo Setup"));
  console.log();

  if (!isInteractive) {
    // Non-interactive: use env or defaults, skip prompts
    const model = process.env.POLPO_MODEL;
    const projectName = existing?.project ?? basename(cwd);
    const config = generatePolpoConfigDefault(projectName, { model: model ?? undefined });
    savePolpoConfig(polpoDir, config);
    if (!model) {
      console.log(chalk.yellow("  No model configured. Set POLPO_MODEL env var or run 'polpo setup' interactively."));
    } else {
      console.log(chalk.green(`  Config saved with model: ${model}`));
    }
    return;
  }

  // ── Step 1: Project name ──
  const defaultProject = existing?.project ?? basename(cwd);
  const projectName = await promptWithDefault("Project name", defaultProject);

  // ── Step 2: Detect providers ──
  console.log();
  console.log(chalk.dim("  Detecting providers..."));
  const providers = detectProviders();

  if (providers.length > 0) {
    console.log();
    for (const p of providers) {
      const source = p.source === "env" ? `env: ${p.envVar}` : "OAuth profile";
      console.log(`  ${chalk.green("✓")} ${chalk.bold(p.name)} ${chalk.dim(`(${source})`)}`);
    }
    console.log();
  } else {
    console.log(chalk.yellow("  No providers detected."));
    console.log();
  }

  // ── Step 3: Model selection ──
  let selectedModel: string | undefined;

  if (providers.length > 0) {
    // Build model picker from detected providers
    const modelOptions: { spec: string; label: string }[] = [];
    for (const p of providers) {
      const recommended = RECOMMENDED_MODELS[p.name];
      if (recommended) {
        modelOptions.push(...recommended);
      } else {
        modelOptions.push({ spec: `${p.name}:`, label: `${p.name} (enter model ID)` });
      }
    }

    // Cap at 8 models + custom option
    const capped = modelOptions.slice(0, 8);
    const labels = [
      ...capped.map((m) => `${chalk.bold(m.spec)} ${chalk.dim(`— ${m.label}`)}`),
      chalk.dim("Enter custom model"),
    ];

    console.log(chalk.bold("  Select a model for your agents:"));
    console.log();
    const idx = await pickFromList(labels, "Select (1-" + labels.length + ")");

    if (idx >= 0 && idx < capped.length) {
      selectedModel = capped[idx].spec;
    } else {
      // Custom model or invalid selection
      const custom = await promptUser("  Model spec (provider:model): ");
      if (custom) selectedModel = custom;
    }
  } else {
    // No providers — offer options
    console.log(chalk.bold("  How would you like to configure a model?"));
    console.log();
    const idx = await pickFromList(
      [
        "Enter an API key now",
        "Skip for now (configure later)",
      ],
      "Select (1-2)"
    );

    if (idx === 0) {
      // Enter API key
      const topProviders = ["anthropic", "openai", "google", "groq", "openrouter"];
      console.log();
      console.log(chalk.bold("  Select a provider:"));
      console.log();
      const pIdx = await pickFromList(
        topProviders.map((p) => `${chalk.bold(p)} ${chalk.dim(`(${PROVIDER_ENV_MAP[p]})`)}`),
        "Select (1-" + topProviders.length + ")"
      );

      if (pIdx >= 0) {
        const provider = topProviders[pIdx];
        const envVar = PROVIDER_ENV_MAP[provider];
        const key = await promptUser(`  ${envVar}: `);
        if (key) {
          process.env[envVar] = key;
          console.log(chalk.green(`  ✓ ${envVar} set for this session.`));
          console.log(chalk.dim(`    Add to your shell profile to persist: export ${envVar}=${key.slice(0, 8)}...`));
          console.log();

          // Pick a model from this provider
          const recommended = RECOMMENDED_MODELS[provider];
          if (recommended && recommended.length > 0) {
            selectedModel = recommended[0].spec;
            console.log(`  Using ${chalk.bold(selectedModel)}`);
          } else {
            const custom = await promptUser(`  Model spec (${provider}:model-id): `);
            if (custom) selectedModel = custom;
          }
        }
      }
    }
    // idx === 1 or invalid → skip, selectedModel stays undefined
  }

  // ── Step 4: Team configuration ──
  console.log();
  const defaultTeamName = existing?.teams?.[0]?.name ?? "default";
  const defaultAgentName = existing?.teams?.[0]?.agents?.[0]?.name ?? "dev-1";
  const defaultAgentRole = existing?.teams?.[0]?.agents?.[0]?.role ?? "developer";

  const teamName = await promptWithDefault("Team name", defaultTeamName);
  const agentName = await promptWithDefault("Agent name", defaultAgentName);
  const agentRole = await promptWithDefault("Agent role", defaultAgentRole);

  // ── Step 5: Write config ──
  const config = generatePolpoConfigDefault(projectName, {
    model: selectedModel,
    teamName,
    agentName,
    agentRole,
  });
  savePolpoConfig(polpoDir, config);

  // ── Summary ──
  console.log();
  console.log(chalk.green("  Setup complete!"));
  console.log();
  console.log(`  ${chalk.dim("Project:")} ${projectName}`);
  console.log(`  ${chalk.dim("Model:")}   ${selectedModel ?? chalk.yellow("not set — configure before running agents")}`);
  console.log(`  ${chalk.dim("Team:")}    ${teamName}`);
  console.log(`  ${chalk.dim("Agent:")}   ${agentName} (${agentRole})`);
  console.log();
  console.log(chalk.dim("  Config saved to .polpo/polpo.json"));
  console.log();
}

// ── CLI command registration ────────────────────────

export function registerSetupCommand(parent: Command): void {
  parent
    .command("setup")
    .description("Interactive setup wizard — configure model, team, and providers")
    .action(async () => {
      await runSetupWizard();
    });
}
