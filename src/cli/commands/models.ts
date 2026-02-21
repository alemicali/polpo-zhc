/**
 * CLI commands for model and provider management.
 *
 * polpo models list       — list available models and providers
 * polpo models status     — show resolved model config, fallbacks, and auth status
 * polpo models scan       — scan for locally running model servers (Ollama, vLLM, etc.)
 *
 * Aligned with OpenClaw's `openclaw models list/status/scan` interface.
 */

import { Command } from "commander";
import chalk from "chalk";

export function registerModelsCommands(parent: Command): void {
  const models = parent
    .command("models")
    .description("Manage models and LLM providers");

  // ── polpo models list ─────────────────────────────

  models
    .command("list")
    .description("List available models from all providers")
    .option("--provider <name>", "Filter by provider name")
    .option("--all", "Show all models (not just featured)")
    .option("--json", "Output as JSON")
    .option("--plain", "One model per line (machine-friendly)")
    .action(async (opts: { provider?: string; all?: boolean; json?: boolean; plain?: boolean }) => {
      const { listProviders, listModels } = await import("../../llm/pi-client.js");

      const providers = opts.provider ? [opts.provider] : listProviders();
      const allModels = opts.provider
        ? listModels(opts.provider)
        : providers.flatMap(p => listModels(p));

      if (opts.json) {
        console.log(JSON.stringify(allModels, null, 2));
        return;
      }

      if (opts.plain) {
        for (const m of allModels) {
          console.log(`${m.provider}:${m.id}`);
        }
        return;
      }

      // Group by provider
      const byProvider = new Map<string, typeof allModels>();
      for (const m of allModels) {
        const list = byProvider.get(m.provider) || [];
        list.push(m);
        byProvider.set(m.provider, list);
      }

      console.log(chalk.bold(`\nAvailable Models`) + chalk.dim(` (${allModels.length} total across ${byProvider.size} providers)\n`));

      for (const [provider, pModels] of byProvider) {
        // Show top N unless --all
        const show = opts.all ? pModels : pModels.slice(0, 5);

        console.log(`  ${chalk.bold.cyan(provider)} ${chalk.dim(`(${pModels.length} models)`)}`);
        for (const m of show) {
          const tags: string[] = [];
          if (m.reasoning) tags.push(chalk.magenta("reasoning"));
          if (m.cost.input === 0 && m.cost.output === 0) tags.push(chalk.green("FREE"));
          const costStr = m.cost.input > 0
            ? chalk.dim(`$${m.cost.input.toFixed(2)}/$${m.cost.output.toFixed(2)} per 1M tok`)
            : "";
          const ctxStr = chalk.dim(`${(m.contextWindow / 1000).toFixed(0)}k ctx`);
          const tagStr = tags.length > 0 ? ` ${tags.join(" ")}` : "";

          console.log(`    ${chalk.white(m.id)}${tagStr}`);
          console.log(`      ${ctxStr}  ${costStr}`);
        }
        if (!opts.all && pModels.length > show.length) {
          console.log(chalk.dim(`    ... and ${pModels.length - show.length} more (use --all to see all)`));
        }
        console.log();
      }
    });

  // ── polpo models status ───────────────────────────

  models
    .command("status")
    .description("Show resolved model configuration, fallbacks, and auth status")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("--json", "Output as JSON")
    .option("--check", "Exit code 1 if auth missing/expired, 2 if expiring soon")
    .option("--plain", "Print only the resolved primary model")
    .action(async (opts: { dir: string; json?: boolean; check?: boolean; plain?: boolean }) => {
      const { resolve } = await import("node:path");
      const { loadPolpoConfig } = await import("../../core/config.js");
      const { resolveModel, resolveModelSpec, resolveApiKey, resolveApiKeyAsync, parseModelSpec, setProviderOverrides, getProviderCooldowns } = await import("../../llm/pi-client.js");
      const { getAllProfiles, isProfileAvailable, getUsageStats } = await import("../../auth/index.js");

      const polpoDir = resolve(opts.dir, ".polpo");
      let config;
      try {
        config = loadPolpoConfig(polpoDir);
      } catch {
        config = null;
      }

      // Set provider overrides if config loaded
      if (config?.providers) {
        setProviderOverrides(config.providers);
      }

      // Resolve the primary model
      const modelSpec = config?.settings?.orchestratorModel;
      const primarySpec = resolveModelSpec(modelSpec);
      const primary = primarySpec || process.env.POLPO_MODEL;
      if (!primary) {
        console.log(chalk.yellow("\n  No default model configured. Run 'polpo setup' to set one.\n"));
        return;
      }

      if (opts.plain) {
        console.log(primary);
        return;
      }

      // Build status object
      const { provider: primaryProvider } = parseModelSpec(primary);
      let primaryModel;
      try {
        primaryModel = resolveModel(primary);
      } catch {
        primaryModel = null;
      }

      // Fallbacks
      const fallbacks = typeof modelSpec === "object" && modelSpec?.fallbacks
        ? modelSpec.fallbacks
        : [];

      // Auth status per provider
      const relevantProviders = new Set<string>();
      relevantProviders.add(primaryProvider);
      for (const fb of fallbacks) {
        relevantProviders.add(parseModelSpec(fb).provider);
      }

      const authStatus: Record<string, { hasEnvKey: boolean; hasOAuth: boolean; profileCount: number; issues: string[] }> = {};
      const profiles = getAllProfiles();

      for (const provider of relevantProviders) {
        const envKey = !!resolveApiKey(provider);
        const provProfiles = profiles.filter(p => p.profile.provider === provider);
        const issues: string[] = [];

        for (const { id, profile } of provProfiles) {
          if (profile.expires && Date.now() >= profile.expires && !profile.refresh) {
            issues.push(`${id}: expired, no refresh token`);
          } else if (profile.expires) {
            const hoursLeft = (profile.expires - Date.now()) / 3_600_000;
            if (hoursLeft < 24 && hoursLeft > 0) {
              issues.push(`${id}: expires in ${hoursLeft.toFixed(1)}h`);
            }
          }
          if (!isProfileAvailable(id)) {
            const stats = getUsageStats(id);
            if (stats?.disabledUntil && Date.now() < stats.disabledUntil) {
              issues.push(`${id}: billing disabled until ${new Date(stats.disabledUntil).toLocaleString()}`);
            } else if (stats?.cooldownUntil && Date.now() < stats.cooldownUntil) {
              issues.push(`${id}: in cooldown until ${new Date(stats.cooldownUntil).toLocaleString()}`);
            }
          }
        }

        authStatus[provider] = {
          hasEnvKey: envKey,
          hasOAuth: provProfiles.some(p => p.profile.type === "oauth"),
          profileCount: provProfiles.length,
          issues,
        };
      }

      // Provider cooldowns
      const cooldowns = getProviderCooldowns();

      if (opts.json) {
        console.log(JSON.stringify({
          primary,
          primaryModel: primaryModel ? { id: primaryModel.id, name: primaryModel.name, provider: primaryModel.provider } : null,
          fallbacks,
          auth: authStatus,
          cooldowns,
        }, null, 2));

        if (opts.check) {
          const hasMissing = Object.values(authStatus).some(s => !s.hasEnvKey && !s.hasOAuth);
          const hasExpiring = Object.values(authStatus).some(s => s.issues.length > 0);
          process.exit(hasMissing ? 1 : hasExpiring ? 2 : 0);
        }
        return;
      }

      // Pretty output
      console.log(chalk.bold("\nModel Configuration\n"));

      // Primary
      const primaryIcon = primaryModel ? chalk.green("*") : chalk.red("x");
      console.log(`  ${primaryIcon} ${chalk.bold("Primary:")} ${chalk.cyan(primary)}`);
      if (primaryModel) {
        const tags: string[] = [];
        if (primaryModel.reasoning) tags.push("reasoning");
        if (primaryModel.cost.input === 0) tags.push("FREE");
        console.log(chalk.dim(`    ${primaryModel.name} | ${(primaryModel.contextWindow / 1000).toFixed(0)}k ctx${tags.length > 0 ? ` | ${tags.join(", ")}` : ""}`));
      }

      // Fallbacks
      if (fallbacks.length > 0) {
        console.log(`\n  ${chalk.bold("Fallback chain:")}`);
        for (let i = 0; i < fallbacks.length; i++) {
          const fb = fallbacks[i];
          let fbModel;
          try { fbModel = resolveModel(fb); } catch { fbModel = null; }
          const icon = fbModel ? chalk.yellow(`${i + 1}.`) : chalk.red(`${i + 1}.`);
          console.log(`    ${icon} ${fb}`);
        }
      } else {
        console.log(chalk.dim("\n  No fallback models configured."));
      }

      // Auth
      console.log(chalk.bold("\n  Provider Auth:\n"));
      for (const [provider, status] of Object.entries(authStatus)) {
        const icons: string[] = [];
        if (status.hasEnvKey) icons.push(chalk.green("env"));
        if (status.hasOAuth) icons.push(chalk.green("oauth"));
        if (!status.hasEnvKey && !status.hasOAuth) icons.push(chalk.red("none"));

        const profileInfo = status.profileCount > 0
          ? chalk.dim(` (${status.profileCount} profile${status.profileCount > 1 ? "s" : ""})`)
          : "";

        console.log(`    ${chalk.bold(provider)}: ${icons.join(" + ")}${profileInfo}`);

        for (const issue of status.issues) {
          console.log(`      ${chalk.yellow("!")} ${issue}`);
        }
      }

      // Cooldowns
      const activeCooldowns = Object.entries(cooldowns).filter(([, v]) => Date.now() < v.until);
      if (activeCooldowns.length > 0) {
        console.log(chalk.bold("\n  Active Cooldowns:\n"));
        for (const [provider, cd] of activeCooldowns) {
          const remaining = Math.ceil((cd.until - Date.now()) / 60000);
          console.log(`    ${chalk.red("*")} ${provider}: ${remaining}m remaining (${cd.reason || "unknown"}, ${cd.errorCount} errors)`);
        }
      }

      console.log();

      if (opts.check) {
        const hasMissing = Object.values(authStatus).some(s => !s.hasEnvKey && !s.hasOAuth);
        const hasExpiring = Object.values(authStatus).some(s => s.issues.length > 0);
        if (hasMissing) {
          console.log(chalk.red("Missing auth for one or more providers."));
          process.exit(1);
        }
        if (hasExpiring) {
          console.log(chalk.yellow("Auth issues detected (expiring or disabled)."));
          process.exit(2);
        }
        console.log(chalk.green("All providers authenticated."));
      }
    });

  // ── polpo models scan ─────────────────────────────

  models
    .command("scan")
    .description("Scan for locally running model servers (Ollama, vLLM, LM Studio, etc.)")
    .option("--json", "Output as JSON")
    .option("--timeout <ms>", "Connection timeout per endpoint", "3000")
    .action(async (opts: { json?: boolean; timeout?: string }) => {
      const timeout = parseInt(opts.timeout || "3000", 10);

      // Common local model server endpoints
      const endpoints = [
        { name: "Ollama", url: "http://localhost:11434/api/tags", modelsPath: "models", displayUrl: "http://localhost:11434" },
        { name: "vLLM", url: "http://localhost:8000/v1/models", modelsPath: "data", displayUrl: "http://localhost:8000" },
        { name: "LM Studio", url: "http://localhost:1234/v1/models", modelsPath: "data", displayUrl: "http://localhost:1234" },
        { name: "LocalAI", url: "http://localhost:8080/v1/models", modelsPath: "data", displayUrl: "http://localhost:8080" },
        { name: "LiteLLM Proxy", url: "http://localhost:4000/v1/models", modelsPath: "data", displayUrl: "http://localhost:4000" },
        { name: "TGI", url: "http://localhost:8080/info", modelsPath: null, displayUrl: "http://localhost:8080" },
      ];

      interface DiscoveredServer {
        name: string;
        url: string;
        models: string[];
        error?: string;
      }

      const discovered: DiscoveredServer[] = [];

      if (!opts.json) {
        console.log(chalk.bold("\nScanning for local model servers...\n"));
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout * endpoints.length + 5000);

      for (const ep of endpoints) {
        try {
          const abortCtrl = new AbortController();
          const timeoutHandle = setTimeout(() => abortCtrl.abort(), timeout);

          const res = await fetch(ep.url, {
            signal: abortCtrl.signal,
            headers: { Accept: "application/json" },
          });
          clearTimeout(timeoutHandle);

          if (!res.ok) {
            continue;
          }

          const data = await res.json() as Record<string, unknown>;
          let models: string[] = [];

          if (ep.modelsPath && data[ep.modelsPath] && Array.isArray(data[ep.modelsPath])) {
            models = (data[ep.modelsPath] as { id?: string; name?: string; model?: string }[])
              .map(m => m.id || m.name || m.model || "unknown")
              .filter(Boolean);
          } else if (ep.name === "TGI" && typeof data === "object") {
            // TGI /info returns model_id directly
            const modelId = (data as { model_id?: string }).model_id;
            if (modelId) models = [modelId];
          }

          discovered.push({ name: ep.name, url: ep.displayUrl, models });

          if (!opts.json) {
            console.log(`  ${chalk.green("*")} ${chalk.bold(ep.name)} ${chalk.dim(`(${ep.displayUrl})`)}`);
            if (models.length > 0) {
              for (const m of models.slice(0, 10)) {
                console.log(`    ${chalk.white(m)}`);
              }
              if (models.length > 10) {
                console.log(chalk.dim(`    ... and ${models.length - 10} more`));
              }
            } else {
              console.log(chalk.dim("    No models loaded"));
            }
            console.log();
          }
        } catch {
          // Server not running or unreachable — skip silently
        }
      }

      clearTimeout(timeoutId);

      if (opts.json) {
        console.log(JSON.stringify(discovered, null, 2));
        return;
      }

      if (discovered.length === 0) {
        console.log(chalk.dim("  No local model servers found."));
        console.log(chalk.dim("  Supported: Ollama, vLLM, LM Studio, LocalAI, LiteLLM, TGI\n"));
      } else {
        console.log(chalk.dim(`  Found ${discovered.length} server${discovered.length > 1 ? "s" : ""} with ${discovered.reduce((s, d) => s + d.models.length, 0)} model${discovered.reduce((s, d) => s + d.models.length, 0) !== 1 ? "s" : ""}.\n`));
        console.log(chalk.dim("  To use a local model, add to polpo.json:"));
        console.log(chalk.dim('    "providers": { "ollama": { "baseUrl": "http://localhost:11434/v1", "api": "openai-completions" } }'));
        console.log(chalk.dim('    "orchestratorModel": "ollama:llama3.2"\n'));
      }
    });
}
