/**
 * CLI commands for agent identity onboarding and management.
 *
 * polpo agent onboard <name>  — Interactive wizard for identity + vault + hierarchy
 * polpo agent list             — Show agents with org chart hierarchy
 * polpo agent show <name>      — Detailed agent view (identity + vault masked)
 */

import { resolve } from "node:path";
import readline from "node:readline";
import type { Command } from "commander";
import chalk from "chalk";
import { loadPolpoConfig, savePolpoConfig } from "../../core/config.js";
import type { AgentConfig, AgentIdentity, AgentResponsibility, VaultEntry } from "../../core/types.js";
import { EncryptedVaultStore } from "../../vault/encrypted-store.js";

// ── Readline helpers ──

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => { rl.close(); res(answer.trim()); });
  });
}

async function askDefault(label: string, def: string): Promise<string> {
  const answer = await ask(`  ${label}${def ? chalk.dim(` [${def}]`) : ""}: `);
  return answer || def;
}

async function askYesNo(label: string, def: boolean): Promise<boolean> {
  const hint = def ? "Y/n" : "y/N";
  const answer = await ask(`  ${label} (${hint}): `);
  if (!answer) return def;
  return answer.toLowerCase().startsWith("y");
}

async function pickOne(label: string, choices: string[]): Promise<number> {
  console.log(`  ${label}`);
  for (let i = 0; i < choices.length; i++) {
    console.log(`    ${chalk.cyan(`${i + 1}.`)} ${choices[i]}`);
  }
  const answer = await ask(`  Choice [1]: `);
  const idx = parseInt(answer || "1", 10) - 1;
  return idx >= 0 && idx < choices.length ? idx : 0;
}

export function registerAgentOnboardCommands(program: Command): void {
  const agent = program
    .command("agent")
    .description("Agent identity and management");

  // ── polpo agent onboard <name> ──

  agent
    .command("onboard <name>")
    .description("Interactive wizard to set up an agent's identity, vault, and hierarchy")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (name: string, opts: { dir: string }) => {
      const polpoDir = resolve(opts.dir, ".polpo");
      const config = loadPolpoConfig(polpoDir);
      if (!config) {
        console.log(chalk.red("No polpo.json found. Run 'polpo init' first."));
        process.exit(1);
      }

      const defaultTeam = config.teams?.[0];
      if (!defaultTeam) {
        console.log(chalk.red("No team configured. Run 'polpo init' first."));
        process.exit(1);
      }
      const agentIdx = defaultTeam.agents.findIndex(a => a.name === name);
      if (agentIdx < 0) {
        console.log(chalk.red(`Agent "${name}" not found. Available: ${defaultTeam.agents.map(a => a.name).join(", ")}`));
        process.exit(1);
      }

      const agentCfg = defaultTeam.agents[agentIdx] as AgentConfig;
      console.log(chalk.bold(`\n  Onboarding agent: ${name}\n`));

      // ── 1. Identity ──
      console.log(chalk.cyan("  Step 1: Identity\n"));
      const displayName = await askDefault("Display name (e.g. Alice Chen)", agentCfg.identity?.displayName ?? "");
      const title = await askDefault("Job title", agentCfg.identity?.title ?? agentCfg.role ?? "");
      const company = await askDefault("Company", agentCfg.identity?.company ?? "");
      const email = await askDefault("Email", agentCfg.identity?.email ?? "");
      const timezone = await askDefault("Timezone (e.g. Europe/Rome)", agentCfg.identity?.timezone ?? "");
      const bio = await askDefault("Bio (optional)", agentCfg.identity?.bio ?? "");

      // ── 2. Persona ──
      console.log(chalk.cyan("\n  Step 2: Persona\n"));
      const existingResp = agentCfg.identity?.responsibilities ?? [];
      const responsibilities: (string | AgentResponsibility)[] = [];

      if (existingResp.length > 0) {
        const respDisplay = existingResp.map(r => typeof r === "string" ? r : `${r.area}: ${r.description}`).join(", ");
        console.log(chalk.dim(`  Current responsibilities: ${respDisplay}`));
        const replace = await askYesNo("Replace existing responsibilities?", false);
        if (!replace) {
          responsibilities.push(...existingResp);
        }
      }

      if (responsibilities.length === 0 || existingResp.length === 0) {
        const useStructured = await askYesNo("Use structured responsibilities (area + description + priority)?", true);

        if (useStructured) {
          console.log(chalk.dim("  Enter responsibilities (empty area to finish):"));
          while (true) {
            const area = await ask("    Area (e.g. Customer Relations): ");
            if (!area) break;
            const desc = await ask("    Description: ");
            if (!desc) break;
            const prioChoices = ["(skip)", "critical", "high", "medium", "low"];
            const prioIdx = await pickOne("Priority:", prioChoices);
            const prio = prioIdx === 0 ? undefined : prioChoices[prioIdx] as "critical" | "high" | "medium" | "low";
            responsibilities.push({ area, description: desc, ...(prio ? { priority: prio } : {}) });
          }
        } else {
          console.log(chalk.dim("  Enter responsibilities (one per line, empty to finish):"));
          while (true) {
            const r = await ask("    > ");
            if (!r) break;
            responsibilities.push(r);
          }
        }
      }

      const tone = await askDefault(
        "Communication tone (e.g. Professional but warm. Uses first names. Keeps emails under 3 paragraphs.)",
        agentCfg.identity?.tone ?? "",
      );
      const personality = await askDefault(
        "Personality traits (e.g. Detail-oriented and empathetic. Anticipates concerns. Data-driven.)",
        agentCfg.identity?.personality ?? "",
      );
      const socialsRaw = await askDefault(
        "Social accounts (comma-separated, e.g. x:@alice, github:alice, linkedin:linkedin.com/in/alice)",
        agentCfg.identity?.socials
          ? Object.entries(agentCfg.identity.socials).map(([k, v]) => `${k}:${v}`).join(", ")
          : "",
      );

      // ── 3. Hierarchy ──
      console.log(chalk.cyan("\n  Step 3: Hierarchy\n"));
      const otherAgents = defaultTeam.agents.filter(a => a.name !== name).map(a => a.name);
      let reportsTo: string | undefined = agentCfg.reportsTo;

      if (otherAgents.length > 0) {
        const choices = ["(none — top-level)", ...otherAgents];
        const idx = await pickOne("Reports to:", choices);
        reportsTo = idx === 0 ? undefined : otherAgents[idx - 1];
      } else {
        console.log(chalk.dim("  No other agents available."));
      }

      // ── 4. Email ──
      console.log(chalk.cyan("\n  Step 4: Email\n"));
      const hasEmailTools = agentCfg.allowedTools?.some(t => t.toLowerCase().startsWith("email_")) ?? false;
      const enableEmail = await askYesNo("Configure email tools?", hasEmailTools);
      const vaultStore = new EncryptedVaultStore(polpoDir);
      const existingVault = vaultStore.getAllForAgent(name);
      const vaultEntries: Record<string, VaultEntry> = {};

      if (enableEmail) {
        const existingSmtp = existingVault.email;
        if (await askYesNo("Configure SMTP (send)?", !existingSmtp)) {
          vaultEntries.email = {
            type: "smtp",
            label: "SMTP Email",
            credentials: {
              host: await askDefault("SMTP host", existingSmtp?.credentials?.host ?? "smtp.gmail.com"),
              port: await askDefault("SMTP port", existingSmtp?.credentials?.port ?? "587"),
              user: await askDefault("SMTP user (e.g. ${ALICE_SMTP_USER})", existingSmtp?.credentials?.user ?? ""),
              pass: await askDefault("SMTP pass (e.g. ${ALICE_SMTP_PASS})", existingSmtp?.credentials?.pass ?? ""),
              from: await askDefault("From address", existingSmtp?.credentials?.from ?? email ?? ""),
            },
          };
        }

        const existingImap = existingVault["email-inbox"];
        if (await askYesNo("Configure IMAP (read)?", !existingImap)) {
          vaultEntries["email-inbox"] = {
            type: "imap",
            label: "IMAP Email",
            credentials: {
              host: await askDefault("IMAP host", existingImap?.credentials?.host ?? "imap.gmail.com"),
              port: await askDefault("IMAP port", existingImap?.credentials?.port ?? "993"),
              user: await askDefault("IMAP user (env var)", existingImap?.credentials?.user ?? ""),
              pass: await askDefault("IMAP pass (env var)", existingImap?.credentials?.pass ?? ""),
            },
          };
        }
      }

      // ── 5. Extra Vault ──
      console.log(chalk.cyan("\n  Step 5: Additional Credentials\n"));
      while (await askYesNo("Add a vault entry (API key, login, etc.)?", false)) {
        const svcName = await askDefault("Service name (e.g. twitter, slack)", "");
        if (!svcName) continue;
        const types = ["api_key", "oauth", "login", "custom"] as const;
        const typeIdx = await pickOne("Credential type:", types.map(t => t));
        const svcType = types[typeIdx];
        const svcLabel = await askDefault("Label", svcName);

        const creds: Record<string, string> = {};
        console.log(chalk.dim("  Enter credential fields (empty key to stop):"));
        while (true) {
          const key = await ask("    Key: ");
          if (!key) break;
          const val = await ask(`    Value for ${key}: `);
          creds[key] = val;
        }
        if (Object.keys(creds).length > 0) {
          vaultEntries[svcName] = { type: svcType, label: svcLabel, credentials: creds };
        }
      }

      // ── Build & Save ──
      const identity: AgentIdentity = {};
      if (displayName) identity.displayName = displayName;
      if (title) identity.title = title;
      if (company) identity.company = company;
      if (email) identity.email = email;
      if (timezone) identity.timezone = timezone;
      if (bio) identity.bio = bio;
      if (responsibilities.length > 0) identity.responsibilities = responsibilities;
      if (tone) identity.tone = tone;
      if (personality) identity.personality = personality;
      if (socialsRaw) {
        const socials: Record<string, string> = {};
        for (const pair of socialsRaw.split(",").map(s => s.trim()).filter(Boolean)) {
          const colonIdx = pair.indexOf(":");
          if (colonIdx > 0) {
            socials[pair.slice(0, colonIdx).trim()] = pair.slice(colonIdx + 1).trim();
          }
        }
        if (Object.keys(socials).length > 0) identity.socials = socials;
      }

      const updated: Record<string, unknown> = { ...agentCfg };
      if (Object.keys(identity).length > 0) updated.identity = identity;
      if (reportsTo) updated.reportsTo = reportsTo;
      else delete updated.reportsTo;
      // If email was enabled, ensure email_* is in allowedTools
      if (enableEmail && !hasEmailTools) {
        const tools = (updated.allowedTools as string[] | undefined) ?? [];
        tools.push("email_*");
        updated.allowedTools = tools;
      }
      // Vault tools are core — always available, no need to add to allowedTools

      defaultTeam.agents[agentIdx] = updated as any;
      savePolpoConfig(polpoDir, config);

      // Save vault entries to encrypted store
      for (const [svc, entry] of Object.entries(vaultEntries)) {
        vaultStore.set(name, svc, entry);
      }
      const vaultCount = Object.keys(vaultEntries).length;

      console.log(chalk.green(`\n  Agent "${name}" onboarded successfully!`));
      console.log(chalk.dim("  Config saved to .polpo/polpo.json"));
      if (vaultCount > 0) {
        console.log(chalk.dim(`  ${vaultCount} credential(s) saved to .polpo/vault.enc (encrypted)`));
      }
      console.log();
    });

  // ── polpo agent list ──

  agent
    .command("list")
    .description("Show agents with org chart hierarchy")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (opts: { dir: string }) => {
      const polpoDir = resolve(opts.dir, ".polpo");
      const config = loadPolpoConfig(polpoDir);
      if (!config) {
        console.log(chalk.red("No polpo.json found. Run 'polpo init' first."));
        process.exit(1);
      }

      const defaultTeam = config.teams?.[0];
      const agents = (defaultTeam?.agents ?? []) as AgentConfig[];
      if (agents.length === 0) {
        console.log(chalk.dim("  No agents configured."));
        return;
      }

      console.log(chalk.bold(`\n  Team: ${defaultTeam?.name ?? "default"}\n`));

      const roots = agents.filter(a => !a.reportsTo);
      const childrenOf = (name: string) => agents.filter(a => a.reportsTo === name);

      let listVaultStore: EncryptedVaultStore | undefined;
      try { listVaultStore = new EncryptedVaultStore(polpoDir); } catch { /* vault unavailable */ }

      const printAgent = (a: AgentConfig, prefix: string, isLast: boolean) => {
        const connector = isLast ? "└── " : "├── ";
        const display = a.identity?.displayName ? `${a.name} (${a.identity.displayName})` : a.name;
        const titleStr = a.identity?.title ?? a.role ?? "";
        const vaultCount = listVaultStore?.list(a.name).length ?? 0;
        const flags: string[] = [];
        const aTools = a.allowedTools ?? [];
        if (aTools.some(t => t.toLowerCase().startsWith("email_"))) flags.push("email");
        if (aTools.some(t => t.toLowerCase().startsWith("browser_"))) flags.push("browser");
        if (aTools.some(t => t.toLowerCase().startsWith("image_"))) flags.push("image");
        if (aTools.some(t => t.toLowerCase().startsWith("video_"))) flags.push("video");
        if (aTools.some(t => t.toLowerCase().startsWith("audio_"))) flags.push("audio");
        if (aTools.some(t => t.toLowerCase().startsWith("excel_"))) flags.push("excel");
        if (aTools.some(t => t.toLowerCase().startsWith("pdf_"))) flags.push("pdf");
        if (aTools.some(t => t.toLowerCase().startsWith("docx_"))) flags.push("docx");
        if (vaultCount > 0) flags.push(`vault:${vaultCount}`);

        console.log(`${prefix}${connector}${chalk.bold(display)}${titleStr ? chalk.dim(` — ${titleStr}`) : ""}${flags.length ? chalk.cyan(` [${flags.join(", ")}]`) : ""}`);

        const children = childrenOf(a.name);
        const childPrefix = prefix + (isLast ? "    " : "│   ");
        children.forEach((child, i) => printAgent(child, childPrefix, i === children.length - 1));
      };

      roots.forEach((root, i) => printAgent(root, "  ", i === roots.length - 1));
      console.log();
    });

  // ── polpo agent show <name> ──

  agent
    .command("show <name>")
    .description("Show detailed agent info (identity + vault with masked credentials)")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (name: string, opts: { dir: string }) => {
      const polpoDir = resolve(opts.dir, ".polpo");
      const config = loadPolpoConfig(polpoDir);
      if (!config) {
        console.log(chalk.red("No polpo.json found. Run 'polpo init' first."));
        process.exit(1);
      }

      const defaultTeam = config.teams?.[0];
      const agentCfg = defaultTeam?.agents?.find(a => a.name === name) as AgentConfig | undefined;
      if (!agentCfg) {
        console.log(chalk.red(`Agent "${name}" not found. Available: ${(defaultTeam?.agents ?? []).map(a => a.name).join(", ")}`));
        process.exit(1);
      }

      console.log(chalk.bold(`\n  Agent: ${agentCfg.name}`));
      if (agentCfg.role) console.log(chalk.dim(`  Role: ${agentCfg.role}`));
      if (agentCfg.model) console.log(chalk.dim(`  Model: ${agentCfg.model}`));
      if (agentCfg.reportsTo) console.log(chalk.dim(`  Reports to: ${agentCfg.reportsTo}`));
      if (agentCfg.createdAt) console.log(chalk.dim(`  Created: ${agentCfg.createdAt}`));

      if (agentCfg.identity) {
        console.log(chalk.cyan("\n  Identity:"));
        const id = agentCfg.identity;
        if (id.displayName) console.log(`    Name: ${id.displayName}`);
        if (id.title) console.log(`    Title: ${id.title}`);
        if (id.company) console.log(`    Company: ${id.company}`);
        if (id.email) console.log(`    Email: ${id.email}`);
        if (id.timezone) console.log(`    Timezone: ${id.timezone}`);
        if (id.bio) console.log(`    Bio: ${id.bio}`);
        if (id.responsibilities?.length) {
          console.log("    Responsibilities:");
          for (const r of id.responsibilities) {
            if (typeof r === "string") {
              console.log(`      - ${r}`);
            } else {
              const prio = r.priority ? chalk.dim(` [${r.priority}]`) : "";
              console.log(`      - ${chalk.bold(r.area)}${prio}: ${r.description}`);
            }
          }
        }
        if (id.tone) console.log(`    Tone: ${id.tone}`);
        if (id.personality) console.log(`    Personality: ${id.personality}`);
        if (id.socials && Object.keys(id.socials).length > 0) {
          console.log(`    Socials: ${Object.entries(id.socials).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
        }
      }

      // Show vault entries from encrypted store
      let showVaultStore: EncryptedVaultStore | undefined;
      try { showVaultStore = new EncryptedVaultStore(polpoDir); } catch { /* vault unavailable */ }
      const vaultList = showVaultStore?.list(name) ?? [];
      if (vaultList.length > 0) {
        console.log(chalk.cyan("\n  Vault (encrypted):"));
        for (const entry of vaultList) {
          console.log(`    ${chalk.bold(entry.service)} (${entry.type})${entry.label ? ` — ${entry.label}` : ""}`);
          for (const key of entry.keys) {
            console.log(chalk.dim(`      ${key}: ***`));
          }
        }
      }

      const showTools = agentCfg.allowedTools ?? [];
      const showFlags: string[] = [];
      if (showTools.some(t => t.toLowerCase().startsWith("browser_"))) showFlags.push("browser");
      if (showTools.some(t => t.toLowerCase().startsWith("email_"))) showFlags.push("email");
      if (showTools.some(t => t.toLowerCase().startsWith("image_"))) showFlags.push("image");
      if (showTools.some(t => t.toLowerCase().startsWith("video_"))) showFlags.push("video");
      if (showTools.some(t => t.toLowerCase().startsWith("audio_"))) showFlags.push("audio");
      if (showTools.some(t => t.toLowerCase().startsWith("excel_"))) showFlags.push("excel");
      if (showTools.some(t => t.toLowerCase().startsWith("pdf_"))) showFlags.push("pdf");
      if (showTools.some(t => t.toLowerCase().startsWith("docx_"))) showFlags.push("docx");
      if (showFlags.length > 0) {
        console.log(chalk.cyan(`\n  Tool categories: `) + showFlags.join(", "));
      }
      console.log();
    });
}

function maskValue(value: string): string {
  if (value.length <= 4) return "****";
  return value[0] + "*".repeat(Math.min(value.length - 2, 10)) + value[value.length - 1];
}
